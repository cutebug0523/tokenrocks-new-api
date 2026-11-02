package service

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestShouldCopyUpstreamHeaderOnlyAllowlisted(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())

	for header, want := range map[string]bool{
		"Content-Type":        true,
		"content-disposition": true,
		"X-Codex-Turn-State":  true,
		"Content-Length":      false,
		"Set-Cookie":          false,
		"X-New-Api-Version":   false,
		"Via":                 false,
		"X-Wb-Account":        false,
		"X-Request-Id":        false,
		"Server":              false,
	} {
		assert.Equal(t, want, ShouldCopyUpstreamHeader(c, header, []string{"v"}), header)
	}

	assert.False(t, ShouldCopyUpstreamHeader(c, common.RequestIdKey, []string{"upstream-id"}))
	assert.Equal(t, "upstream-id", c.GetString(common.UpstreamRequestIdKey))
}

func TestSanitizeUpstreamJSON(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Set(string(constant.ContextKeyOriginalModel), "deepseek-v4.1-flash")

	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "chat body model and upstream usage fields",
			in:   `{"id":"x","model":"deepseek-ai/DeepSeek-V4.1-Flash-1017","usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"credit":0,"prompt_cache_write_tokens":0,"prompt_cache_miss_tokens":3}}`,
			want: `{"id":"x","model":"deepseek-v4.1-flash","usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"prompt_cache_miss_tokens":3}}`,
		},
		{
			name: "nested claude stream model",
			in:   `{"type":"message_start","message":{"model":"deepseek-v4-1-flash","usage":{"input_tokens":3}}}`,
			want: `{"type":"message_start","message":{"model":"deepseek-v4.1-flash","usage":{"input_tokens":3}}}`,
		},
		{
			name: "gemini model version",
			in:   `{"modelVersion":"gemini-upstream-001"}`,
			want: `{"modelVersion":"deepseek-v4.1-flash"}`,
		},
		{
			name: "model text inside content is not a field",
			in:   `{"choices":[{"delta":{"content":"say \"model\": \"x\""}}],"model":"up","usage":null}`,
			want: `{"choices":[{"delta":{"content":"say \"model\": \"x\""}}],"model":"deepseek-v4.1-flash","usage":null}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.JSONEq(t, tc.want, SanitizeUpstreamJSON(c, tc.in))
		})
	}

	errorEvents := []struct {
		name string
		in   string
		want string
	}{
		{"openai and claude error object", `{"type":"error","error":{"type":"overloaded_error","message":"provider-x: switch your pool"}}`, `{"type":"error","error":{"type":"overloaded_error","message":"MSG"}}`},
		{"bare error string", `{"error":"provider-x: switch your pool"}`, `{"error":"MSG"}`},
		{"error object code", `{"error":{"message":"provider-x: switch your pool","type":"upstream_error","code":"provider_x_pool_failed"}}`, `{"error":{"message":"MSG","type":"upstream_error","code":"upstream_error"}}`},
		{"responses error event", `{"type":"error","code":"provider_x_pool_failed","message":"provider-x: switch your pool","sequence_number":3}`, `{"type":"error","code":"upstream_error","message":"MSG","sequence_number":3}`},
		{"responses failed event", `{"type":"response.failed","response":{"id":"r","status":"failed","error":{"code":"provider_x_pool_failed","message":"provider-x: switch your pool"}}}`, `{"type":"response.failed","response":{"id":"r","status":"failed","error":{"code":"upstream_error","message":"MSG"}}}`},
	}
	require.NoError(t, i18n.Init())
	errCtx, _ := gin.CreateTestContext(httptest.NewRecorder())
	errCtx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	errCtx.Request.Header.Set("Accept-Language", "zh-CN")
	errCtx.Set(common.RequestIdKey, "tr-1")
	fixed, err := common.Marshal("上游线路暂时不可用，请稍后重试。 (request id: tr-1)")
	require.NoError(t, err)
	for _, tc := range errorEvents {
		t.Run(tc.name, func(t *testing.T) {
			require.JSONEq(t, strings.ReplaceAll(tc.want, `"MSG"`, string(fixed)), SanitizeUpstreamJSON(errCtx, tc.in))
		})
	}
	for _, kept := range []string{
		`{"choices":[{"delta":{"content":"error"}}]}`,
		`{"type":"response.completed","response":{"status":"completed","error":null}}`,
	} {
		assert.Equal(t, kept, SanitizeUpstreamJSON(errCtx, kept), "events without an error are left alone")
	}
	errCtx.Set(string(constant.ContextKeyGatewayStreamError), true)
	gatewayErr := `{"error":{"message":"额度不足 (request id: tr-1)"}}`
	assert.Equal(t, gatewayErr, SanitizeUpstreamJSON(errCtx, gatewayErr), "errors this gateway raised keep their text")

	plain := `{"model":"up","usage":{"prompt_tokens":1}}`
	assert.Equal(t, plain, SanitizeUpstreamJSON(gin.CreateTestContextOnly(httptest.NewRecorder(), gin.New()), plain), "no requested model and nothing to drop")
}

func TestUserFacingError(t *testing.T) {
	require.NoError(t, i18n.Init())
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	c.Request.Header.Set("Accept-Language", "zh-CN")

	upstream := types.WithOpenAIError(types.OpenAIError{Message: "provider-x: no active route in your pool", Type: "service_unavailable"}, http.StatusServiceUnavailable)
	got := UserFacingError(c, upstream)
	assert.Equal(t, http.StatusServiceUnavailable, got.StatusCode)
	assert.Equal(t, "上游线路暂时不可用，请稍后重试。", got.ToOpenAIError().Message)
	assert.NotContains(t, got.ToClaudeError().Message, "provider-x")

	tooMany := UserFacingError(c, types.WithClaudeError(types.ClaudeError{Message: "upstream says slow down", Type: "rate_limit_error"}, http.StatusTooManyRequests))
	assert.Equal(t, "请求过多或线路容量已满，请降低并发、稍后重试。", tooMany.Error())

	local := types.NewErrorWithStatusCode(errors.New("该令牌无权访问模型 x"), types.ErrorCodeInvalidRequest, http.StatusForbidden)
	assert.Same(t, local, UserFacingError(c, local))
}
