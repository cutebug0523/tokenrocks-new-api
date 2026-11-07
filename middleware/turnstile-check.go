package middleware

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
)

type turnstileCheckResponse struct {
	Success bool `json:"success"`
}

// 前端在浏览器过不了 Turnstile 时换成阿里云验证码，票据写成 "ali." + base64url(CaptchaVerifyParam)，
// 这样登录、注册、发验证码、找回密码、签到原来传 turnstile 参数的地方都不用改。
const aliyunCaptchaTokenPrefix = "ali."

// 中国内地（上海）节点，前端 AliyunCaptchaConfig.region 必须是 cn 才对得上
var aliyunCaptchaEndpoint = "https://captcha.cn-shanghai.aliyuncs.com/"

var aliyunCaptchaClient = &http.Client{Timeout: 5 * time.Second}

func TurnstileCheck() gin.HandlerFunc {
	return func(c *gin.Context) {
		if common.TurnstileCheckEnabled {
			response := c.Query("turnstile")
			if response == "" {
				common.ApiErrorT(c, "Turnstile token is empty")
				c.Abort()
				return
			}
			if encoded, ok := strings.CutPrefix(response, aliyunCaptchaTokenPrefix); ok {
				passed, err := verifyAliyunCaptcha(encoded)
				if err != nil {
					common.SysLog(common.LogText("aliyun captcha verify error: %s", err.Error()))
				}
				if !passed {
					common.ApiErrorT(c, "Turnstile verification failed, please refresh and try again!")
					c.Abort()
					return
				}
				c.Next()
				return
			}
			rawRes, err := http.PostForm("https://challenges.cloudflare.com/turnstile/v0/siteverify", url.Values{
				"secret":   {common.TurnstileSecretKey},
				"response": {response},
				"remoteip": {c.ClientIP()},
			})
			if err != nil {
				common.SysLog(err.Error())
				c.JSON(http.StatusOK, gin.H{
					"success": false,
					"message": err.Error(),
				})
				c.Abort()
				return
			}
			defer rawRes.Body.Close()
			var res turnstileCheckResponse
			err = common.DecodeJson(rawRes.Body, &res)
			if err != nil {
				common.SysLog(err.Error())
				c.JSON(http.StatusOK, gin.H{
					"success": false,
					"message": err.Error(),
				})
				c.Abort()
				return
			}
			if !res.Success {
				common.ApiErrorT(c, "Turnstile verification failed, please refresh and try again!")
				c.Abort()
				return
			}
		}
		c.Next()
	}
}

// verifyAliyunCaptcha 调阿里云 VerifyIntelligentCaptcha（RPC 风格，HMAC-SHA1 签名）。
// 同一个 CaptchaVerifyParam 第二次提交阿里云回 F018，所以不用自己防重放。
// 阿里云建议接口出错时放行；这里一律拦下：只有过不了 Turnstile 的人才走这条路，宁可让他刷新重试，也不在阿里云出故障时敞开注册。
func verifyAliyunCaptcha(encoded string) (bool, error) {
	if !common.AliyunCaptchaReady() {
		return false, fmt.Errorf("aliyun captcha is not configured")
	}
	param, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(param) == 0 {
		return false, fmt.Errorf("bad captcha param")
	}
	values := url.Values{
		"Action":             {"VerifyIntelligentCaptcha"},
		"Version":            {"2023-03-05"},
		"Format":             {"JSON"},
		"AccessKeyId":        {common.AliyunCaptchaAccessKeyId},
		"SignatureMethod":    {"HMAC-SHA1"},
		"SignatureVersion":   {"1.0"},
		"SignatureNonce":     {rand.Text()},
		"Timestamp":          {time.Now().UTC().Format("2006-01-02T15:04:05Z")},
		"CaptchaVerifyParam": {string(param)},
		// 场景由服务端定，前端改了场景会对不上（F020）
		"SceneId": {common.AliyunCaptchaSceneId},
	}
	// 阿里云的编码规则：空格是 %20 不是 +，其余和 QueryEscape 一致；Encode 已按参数名排好序
	canonical := strings.ReplaceAll(values.Encode(), "+", "%20")
	mac := hmac.New(sha1.New, []byte(common.AliyunCaptchaAccessKeySecret+"&"))
	mac.Write([]byte("POST&%2F&" + url.QueryEscape(canonical)))
	values.Set("Signature", base64.StdEncoding.EncodeToString(mac.Sum(nil)))

	resp, err := aliyunCaptchaClient.PostForm(aliyunCaptchaEndpoint, values)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	var res struct {
		Code    string `json:"Code"`
		Message string `json:"Message"`
		Result  struct {
			VerifyResult bool   `json:"VerifyResult"`
			VerifyCode   string `json:"VerifyCode"`
		} `json:"Result"`
	}
	if err := common.DecodeJson(resp.Body, &res); err != nil {
		return false, fmt.Errorf("http %d: %w", resp.StatusCode, err)
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("http %d: %s %s", resp.StatusCode, res.Code, res.Message)
	}
	if !res.Result.VerifyResult {
		return false, fmt.Errorf("rejected: %s", res.Result.VerifyCode)
	}
	return true, nil
}
