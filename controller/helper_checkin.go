package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

// 小助手里的「签到」。网页上的签到要过人机验证（POST /api/user/checkin 挂着 TurnstileCheck），
// 小助手登录时用户已经在浏览器里登录过、点过授权，所以这两个接口只认小助手登录发的访问令牌，不再验证；
// 浏览器会话和用户自己建的别的令牌照旧走原来的签到接口。每人每天只能签一次，由 model.UserCheckin 保证。

// ponytail: 按令牌名认小助手（helperAccessTokenName）。网页上自建同名、带 wallet:write、不过期的令牌也能免验证签到，
// 所以对脚本来说，人机验证从「每天签到一次」变成「每个号登录一次」（走小助手登录也是每 30 天一次）。
// 签到每天只有 ¥0.02～0.05、只能抵调用费，先这样；刷号变多就给小助手令牌加专门的标记字段，或在建令牌时保留这个名字。
func isHelperAccessToken(c *gin.Context) bool {
	id := c.GetInt("access_token_id")
	if id <= 0 {
		return false
	}
	token, err := model.GetUserAccessToken(c.GetInt("id"), id)
	return err == nil && token.Name == helperAccessTokenName
}

func requireHelperAccessToken(c *gin.Context) bool {
	if isHelperAccessToken(c) {
		return true
	}
	writeAccessTokenError(c, http.StatusForbidden, "HELPER_TOKEN_REQUIRED", "Only the helper's access token can use this route.")
	return false
}

// HelperCheckinStatus 和 GET /api/user/checkin 一样，返回本月签到情况和今天签没签（checked_in_today）。
func HelperCheckinStatus(c *gin.Context) {
	if requireHelperAccessToken(c) {
		GetCheckinStatus(c)
	}
}

// HelperCheckin 签到，返回和 POST /api/user/checkin 一样（quota_awarded、checkin_date）。
func HelperCheckin(c *gin.Context) {
	if requireHelperAccessToken(c) {
		DoCheckin(c)
	}
}
