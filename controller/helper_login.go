package controller

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// TokenRocks 小助手 signs in the way RFC 8252 describes for native apps: it
// opens the console in the system browser with a PKCE S256 challenge
// (RFC 7636), the signed-in user approves, the console hands a one-time code to
// the helper's loopback listener, and the helper trades the code and its
// verifier for an access token that can read the profile and usage, redeem codes,
// and create or read API keys.

const (
	helperLoginCodeTTL    = 5 * time.Minute
	helperAccessTokenName = "TokenRocks 小助手"
	// LEE (TokenRocks' desktop agent) signs in through the same flow with
	// client=lee; its token gets its own name and no TR助手 welcome bonus.
	leeAccessTokenName = "LEE"
	helperClientLEE    = "lee"
)

var helperAccessTokenScopes = []string{"api_key:read", "api_key:reveal", "api_key:write", "profile:read", "usage:read", "wallet:write"}

var (
	pkceChallengePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	pkceVerifierPattern  = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
	helperDevicePattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
)

// A desktop sign-in clears the same install's earlier token and any token of
// the same name left unused this long, so stale tokens from reinstalls and
// repeated sign-ins never fill the per-user limit.
const helperStaleTokenAge = 3 * 24 * 60 * 60

// helperLoginGrant is the code's payload: the challenge and the browser session
// that approved it, which must still be live when the code is redeemed.
type helperLoginGrant struct {
	CodeChallenge string                    `json:"code_challenge"`
	Session       model.AuthSessionIdentity `json:"session"`
	Client        string                    `json:"client,omitempty"`
}

// HelperLoginApprove issues the one-time code for a challenge the signed-in
// user approved on the console page.
func HelperLoginApprove(c *gin.Context) {
	identity, ok := requireBrowserSession(c)
	if !ok {
		return
	}
	var req struct {
		CodeChallenge string `json:"code_challenge"`
		Client        string `json:"client"`
	}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil || !pkceChallengePattern.MatchString(req.CodeChallenge) {
		writeAccessTokenError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid request body.")
		return
	}
	grant := helperLoginGrant{CodeChallenge: req.CodeChallenge, Session: identity}
	if req.Client == helperClientLEE {
		grant.Client = helperClientLEE
	}
	payload, err := common.Marshal(grant)
	if err != nil {
		writeSecurityOperationError(c, err)
		return
	}
	code, _, err := model.CreateAuthFlow(model.AuthFlowCreate{
		Purpose: model.AuthFlowPurposeHelperLogin, UserId: identity.UserID, SessionId: identity.SessionID,
		Payload: string(payload), ExpiresAt: time.Now().Add(helperLoginCodeTTL),
	})
	if err != nil {
		writeSecurityOperationError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"code": code})
}

// HelperLoginToken redeems a code for the helper's access token. The code is
// consumed before the verifier and session are checked, so every attempt
// burns it.
func HelperLoginToken(c *gin.Context) {
	var req struct {
		Code         string `json:"code"`
		CodeVerifier string `json:"code_verifier"`
		// DeviceId identifies the install (optional; older helpers omit it).
		DeviceId string `json:"device_id"`
	}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil || req.Code == "" || !pkceVerifierPattern.MatchString(req.CodeVerifier) {
		writeAccessTokenError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid request body.")
		return
	}
	flow, err := model.ConsumeAuthFlow(req.Code, model.AuthFlowMatch{Purpose: model.AuthFlowPurposeHelperLogin})
	if err != nil && !errors.Is(err, model.ErrAuthFlowInvalid) && !errors.Is(err, model.ErrAuthFlowExpired) && !errors.Is(err, model.ErrAuthFlowConsumed) {
		writeSecurityOperationError(c, err)
		return
	}
	var grant helperLoginGrant
	verified := false
	if err == nil && common.UnmarshalJsonStr(flow.Payload, &grant) == nil {
		sum := sha256.Sum256([]byte(req.CodeVerifier))
		verified = subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(grant.CodeChallenge)) == 1
	}
	var user *model.UserBase
	if verified {
		_, user, err = service.ValidateLoginSession(grant.Session)
		if err != nil && !errors.Is(err, service.ErrLoginSessionRevoked) {
			writeSecurityOperationError(c, err)
			return
		}
	}
	if user == nil {
		writeAccessTokenError(c, http.StatusBadRequest, "HELPER_LOGIN_INVALID", "This sign-in has expired or was already used. Sign in again from the helper.")
		return
	}
	scopes, err := service.NormalizeAccessTokenScopes(user.Id, user.Role, helperAccessTokenScopes)
	if err != nil {
		writeSecurityOperationError(c, err)
		return
	}
	name, client := helperAccessTokenName, "helper"
	if grant.Client == helperClientLEE {
		name, client = leeAccessTokenName, helperClientLEE
	}
	device := req.DeviceId
	if !helperDevicePattern.MatchString(device) {
		device = ""
	}
	now := common.GetTimestamp()
	dropped, err := model.PruneSignInAccessTokens(user.Id, name, device, now-helperStaleTokenAge, service.AccessTokenMaxPerUser)
	if err != nil {
		writeSecurityOperationError(c, err)
		return
	}
	for _, old := range dropped {
		recordUserSecurityAudit(c, user.Id, "access_token.revoke", map[string]any{"token_id": old.Id, "name": old.Name, "token_ref": old.TokenHash, "client": client, "reason": "replaced_on_sign_in"})
	}
	raw, token, err := issueAccessTokenFor(user.Id, name, device, scopes, now+int64(service.AccessTokenDefaultExpiryDays)*24*60*60)
	if err != nil {
		writeIssueAccessTokenError(c, err)
		return
	}
	recordUserSecurityAudit(c, user.Id, "access_token.generate", map[string]any{
		"token_id":   token.Id,
		"name":       token.Name,
		"scopes":     scopes,
		"expires_at": token.ExpiresAt,
		"token_ref":  token.TokenHash,
		"client":     client,
	})
	var welcome int
	if client == "helper" {
		welcome, err = model.GrantHelperWelcome(user.Id)
		if err != nil {
			common.SysError(common.LogText("helper welcome bonus failed for user %d: %s", user.Id, err.Error()))
		}
	}
	common.ApiSuccess(c, gin.H{"access_token": raw, "expires_at": token.ExpiresAt, "welcome_quota": welcome})
}

// HelperLogout revokes the access token the request was made with, so signing
// out of the helper also ends its access on the server.
func HelperLogout(c *gin.Context) {
	id := c.GetInt("access_token_id")
	if id <= 0 {
		writeAccessTokenError(c, http.StatusForbidden, "ACCESS_TOKEN_REQUIRED", "Only an access token can sign itself out.")
		return
	}
	userID := c.GetInt("id")
	token, err := model.DeleteUserAccessToken(userID, id)
	if errors.Is(err, model.ErrAccessTokenNotFound) {
		writeAccessTokenError(c, http.StatusNotFound, "ACCESS_TOKEN_NOT_FOUND", model.ErrAccessTokenNotFound.Error())
		return
	}
	if err != nil {
		writeSecurityOperationError(c, err)
		return
	}
	recordUserSecurityAudit(c, userID, "access_token.revoke", map[string]any{"token_id": token.Id, "name": token.Name, "token_ref": token.TokenHash, "client": "helper"})
	common.ApiSuccess(c, nil)
}

// HelperActivity lets the helper poll what the user's relay requests are doing.
// Polling is what turns recording on; see middleware.HelperActivity.
func HelperActivity(c *gin.Context) {
	common.ApiSuccess(c, middleware.PollHelperActivity(c.GetInt("id"), c.Query("after")))
}
