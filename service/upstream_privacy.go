package service

import (
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
)

// What a client receives must not identify the upstream that served it. The
// helpers below strip the three places upstream identity leaks: response
// headers (ShouldCopyUpstreamHeader), response bodies and stream events
// including errors sent after the response started (SanitizeUpstreamJSON), and
// error text (UserFacingError). Admins still see the originals in logs.

// upstreamHeaderAllowlist lists the only upstream response headers copied to
// clients. Content-Length is recomputed locally, and the Codex headers carry
// protocol state that Codex clients need.
var upstreamHeaderAllowlist = []string{"Content-Type", "Content-Disposition", "X-Reasoning-Included", "X-Codex-Turn-State"}

// clientUsageFields lists the usage keys of the OpenAI, DeepSeek, Responses and
// Claude formats. Every other key is bookkeeping, the upstream's or this
// gateway's (billing_usage, usage_semantic, usage_source, cost and the
// claude_cache_creation_* copies), and is dropped.
var clientUsageFields = []string{
	"prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details",
	"prompt_cache_hit_tokens", "prompt_cache_miss_tokens",
	"input_tokens", "output_tokens", "input_tokens_details", "output_tokens_details",
	"cache_creation_input_tokens", "cache_read_input_tokens", "cache_creation", "server_tool_use", "service_tier",
}

var (
	responseModelField = regexp.MustCompile(`"(model|modelVersion)"\s*:\s*"(?:[^"\\]|\\.)*"`)
	responseUsageField = regexp.MustCompile(`"usage"\s*:\s*\{`)
	responseErrorField = regexp.MustCompile(`"(error|response\.failed)"`)
)

// SanitizeUpstreamJSON rewrites one JSON response body or stream event before
// it reaches the client: an upstream error message becomes the fixed one,
// every "model" field becomes the model the client requested, and the usage
// object, at the top level or inside the "message" of a Claude message_start or
// the "response" of a Responses event, keeps only clientUsageFields.
func SanitizeUpstreamJSON(c *gin.Context, data string) string {
	if c == nil {
		return data
	}
	data = hideUpstreamErrorText(c, data)
	if requested := c.GetString(string(constant.ContextKeyOriginalModel)); requested != "" && strings.Contains(data, `"model`) {
		if quoted, err := common.Marshal(requested); err == nil {
			data = responseModelField.ReplaceAllStringFunc(data, func(field string) string {
				return field[:strings.Index(field, ":")+1] + string(quoted)
			})
		}
	}
	if !responseUsageField.MatchString(data) {
		return data
	}
	var body map[string]json.RawMessage
	if common.UnmarshalJsonStr(data, &body) != nil {
		return data
	}
	changed := keepClientUsageFields(body)
	for _, key := range []string{"message", "response"} {
		var inner map[string]json.RawMessage
		if common.GetJsonType(body[key]) != "object" || common.Unmarshal(body[key], &inner) != nil || !keepClientUsageFields(inner) {
			continue
		}
		if cleaned, err := common.Marshal(inner); err == nil {
			body[key], changed = cleaned, true
		}
	}
	if !changed {
		return data
	}
	out, err := common.Marshal(body)
	if err != nil {
		return data
	}
	return string(out)
}

// keepClientUsageFields drops the keys outside clientUsageFields from the
// "usage" object of fields, and reports whether it dropped any.
func keepClientUsageFields(fields map[string]json.RawMessage) bool {
	var usage map[string]json.RawMessage
	if common.GetJsonType(fields["usage"]) != "object" || common.Unmarshal(fields["usage"], &usage) != nil {
		return false
	}
	dropped := false
	for key := range usage {
		if !slices.Contains(clientUsageFields, key) {
			delete(usage, key)
			dropped = true
		}
	}
	if !dropped {
		return false
	}
	cleaned, err := common.Marshal(usage)
	if err != nil {
		return false
	}
	fields["usage"] = cleaned
	return true
}

// upstreamErrorCode replaces an upstream error code, which can name the
// upstream's internal routing.
var upstreamErrorCode = json.RawMessage(`"upstream_error"`)

// hideUpstreamErrorText replaces the message and code of an error that
// upstream put inside a response body or stream event. Once a stream has
// started, such an event is copied to the client as data and never reaches
// UserFacingError. It covers the "error" object of OpenAI, Claude and Gemini,
// a bare "error" string, the Responses "error" event and a Responses
// "response.failed" event.
func hideUpstreamErrorText(c *gin.Context, data string) string {
	if c.GetBool(string(constant.ContextKeyGatewayStreamError)) || !responseErrorField.MatchString(data) {
		return data
	}
	var body map[string]json.RawMessage
	if common.UnmarshalJsonStr(data, &body) != nil {
		return data
	}
	message, err := common.Marshal(common.MessageWithRequestId(i18n.T(c, i18n.UpstreamErrorKey(0)), c.GetString(common.RequestIdKey)))
	if err != nil {
		return data
	}
	var eventType string
	_ = common.Unmarshal(body["type"], &eventType)
	changed := false
	switch {
	case common.GetJsonType(body["error"]) == "string" && string(body["error"]) != `""`:
		body["error"], changed = message, true
	case common.GetJsonType(body["error"]) == "object":
		body["error"], changed = withNeutralError(body["error"], message)
	case eventType == "error":
		changed = neutralizeError(body, message)
	case eventType == "response.failed":
		var response map[string]json.RawMessage
		if common.Unmarshal(body["response"], &response) != nil {
			break
		}
		if response["error"], changed = withNeutralError(response["error"], message); changed {
			body["response"], err = common.Marshal(response)
			changed = err == nil
		}
	}
	if !changed {
		return data
	}
	out, err := common.Marshal(body)
	if err != nil {
		return data
	}
	return string(out)
}

// neutralizeError sets the fixed message and code on an error's fields, and
// reports whether they held an error message.
func neutralizeError(fields map[string]json.RawMessage, message []byte) bool {
	if fields["message"] == nil {
		return false
	}
	fields["message"] = message
	if common.GetJsonType(fields["code"]) == "string" {
		fields["code"] = upstreamErrorCode
	}
	return true
}

// withNeutralError returns an error object passed through neutralizeError,
// and whether it was an error object with a message.
func withNeutralError(errObject json.RawMessage, message []byte) (json.RawMessage, bool) {
	var fields map[string]json.RawMessage
	if common.GetJsonType(errObject) != "object" || common.Unmarshal(errObject, &fields) != nil || !neutralizeError(fields, message) {
		return errObject, false
	}
	out, err := common.Marshal(fields)
	if err != nil {
		return errObject, false
	}
	return out, true
}

// UserFacingError replaces an error that came from upstream with a fixed
// message for its status code, because upstream error text names the upstream
// platform and its routing. Errors raised by this gateway pass through.
func UserFacingError(c *gin.Context, err *types.NewAPIError) *types.NewAPIError {
	if err == nil || err.GetErrorType() == types.ErrorTypeNewAPIError {
		return err
	}
	return types.NewErrorWithStatusCode(errors.New(i18n.T(c, i18n.UpstreamErrorKey(err.StatusCode))), types.ErrorCodeBadResponseStatusCode, err.StatusCode)
}
