package middleware

import (
	"cmp"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/logger"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
)

func abortWithOpenAiMessage(c *gin.Context, statusCode int, message string, code ...types.ErrorCode) {
	codeStr := ""
	if len(code) > 0 {
		codeStr = string(code[0])
	}
	userId := c.GetInt("id")
	_, preparedPluginRoute := c.Get(pluginruntime.ContextKeyRouteRequest)
	if !preparedPluginRoute || !RespondTaskPluginError(c, &dto.TaskError{
		Code:       codeStr,
		Message:    message,
		StatusCode: statusCode,
	}) {
		shown := common.MessageWithRequestId(message, c.GetString(common.RequestIdKey))
		if strings.HasPrefix(c.Request.URL.Path, "/v1/messages") {
			// Claude clients retry every 5xx (Claude Code ten times), so a model
			// this gateway does not serve gets Anthropic's final 404 instead.
			if codeStr == string(types.ErrorCodeModelNotFound) {
				statusCode = http.StatusNotFound
			}
			c.JSON(statusCode, gin.H{
				"type":  "error",
				"error": gin.H{"type": cmp.Or(claudeErrorTypes[statusCode], "api_error"), "message": shown},
			})
		} else {
			c.JSON(statusCode, gin.H{
				"error": gin.H{
					"message": shown,
					"type":    "new_api_error",
					"code":    codeStr,
				},
			})
		}
	}
	c.Abort()
	logger.LogError(c.Request.Context(), common.LogText("user %d | %s", userId, message))
}

// claudeErrorTypes maps a status to Anthropic's error type; other statuses
// are api_error.
var claudeErrorTypes = map[int]string{
	http.StatusBadRequest:            "invalid_request_error",
	http.StatusUnauthorized:          "authentication_error",
	http.StatusPaymentRequired:       "billing_error",
	http.StatusForbidden:             "permission_error",
	http.StatusNotFound:              "not_found_error",
	http.StatusRequestEntityTooLarge: "request_too_large",
	http.StatusTooManyRequests:       "rate_limit_error",
}

// invalidRequestStatus is the status of a request whose body could not be
// read or parsed: 413 when the body exceeds MAX_REQUEST_BODY_MB, else 400.
func invalidRequestStatus(err error) int {
	if common.IsRequestBodyTooLargeError(err) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}

func abortWithMidjourneyMessage(c *gin.Context, statusCode int, code int, description string) {
	c.JSON(statusCode, gin.H{
		"description": description,
		"type":        "new_api_error",
		"code":        code,
	})
	c.Abort()
	logger.LogError(c.Request.Context(), description)
}
