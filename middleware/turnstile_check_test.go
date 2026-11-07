package middleware

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 浏览器过不了 Turnstile 时前端交上来的是阿里云票据，要由服务端拿自己的场景和密钥去阿里云核验，核验不过、阿里云出错都不能放行。
func TestTurnstileCheckAliyunFallback(t *testing.T) {
	const captchaParam = `{"sceneId":"from-browser","certifyId":"abc","deviceToken":"x+y/z"}`
	token := aliyunCaptchaTokenPrefix + base64.RawURLEncoding.EncodeToString([]byte(captchaParam))

	cases := []struct {
		name       string
		configured bool
		status     int
		body       string
		token      string
		wantPassed bool
	}{
		{"aliyun says pass", true, http.StatusOK, `{"Code":"Success","Result":{"VerifyResult":true,"VerifyCode":"T001"}}`, token, true},
		{"aliyun rejects a replayed param", true, http.StatusOK, `{"Code":"Success","Result":{"VerifyResult":false,"VerifyCode":"F018"}}`, token, false},
		{"aliyun returns an error", true, http.StatusInternalServerError, `{"Code":"InternalError","Message":"boom"}`, token, false},
		{"aliyun not configured", false, http.StatusOK, `{"Code":"Success","Result":{"VerifyResult":true}}`, token, false},
		{"param is not base64url", true, http.StatusOK, `{"Code":"Success","Result":{"VerifyResult":true}}`, aliyunCaptchaTokenPrefix + "{bad}", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got url.Values
			aliyun := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.NoError(t, r.ParseForm())
				got = r.PostForm
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer aliyun.Close()

			oldEndpoint, oldEnabled := aliyunCaptchaEndpoint, common.TurnstileCheckEnabled
			oldPrefix, oldScene := common.AliyunCaptchaPrefix, common.AliyunCaptchaSceneId
			oldId, oldSecret := common.AliyunCaptchaAccessKeyId, common.AliyunCaptchaAccessKeySecret
			t.Cleanup(func() {
				aliyunCaptchaEndpoint, common.TurnstileCheckEnabled = oldEndpoint, oldEnabled
				common.AliyunCaptchaPrefix, common.AliyunCaptchaSceneId = oldPrefix, oldScene
				common.AliyunCaptchaAccessKeyId, common.AliyunCaptchaAccessKeySecret = oldId, oldSecret
			})
			aliyunCaptchaEndpoint = aliyun.URL
			common.TurnstileCheckEnabled = true
			common.AliyunCaptchaPrefix, common.AliyunCaptchaSceneId = "prefix", "scene-from-server"
			common.AliyunCaptchaAccessKeyId, common.AliyunCaptchaAccessKeySecret = "ak-id", "ak-secret"
			if !tc.configured {
				common.AliyunCaptchaAccessKeySecret = ""
			}

			gin.SetMode(gin.TestMode)
			engine := gin.New()
			reached := false
			engine.POST("/api/user/login", TurnstileCheck(), func(c *gin.Context) {
				reached = true
				c.Status(http.StatusNoContent)
			})
			request := httptest.NewRequest(http.MethodPost, "/api/user/login?turnstile="+url.QueryEscape(tc.token), nil)
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)

			assert.Equal(t, tc.wantPassed, reached)
			if !tc.configured || tc.token != token {
				assert.Nil(t, got, "no call to aliyun when there is nothing to verify")
				return
			}
			require.NotNil(t, got)
			assert.Equal(t, "VerifyIntelligentCaptcha", got.Get("Action"))
			assert.Equal(t, captchaParam, got.Get("CaptchaVerifyParam"), "the browser param is forwarded unchanged")
			assert.Equal(t, "scene-from-server", got.Get("SceneId"), "the scene comes from server settings, not the browser")
			assert.Equal(t, "ak-id", got.Get("AccessKeyId"))
			assert.NotEmpty(t, got.Get("Signature"))
			assert.NotContains(t, got.Encode(), "ak-secret", "the secret is never sent")
		})
	}
}
