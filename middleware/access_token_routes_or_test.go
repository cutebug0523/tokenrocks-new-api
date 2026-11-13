package middleware

import "testing"

// TokenRocks: the helper's sign-in carries wallet:write but not wallet:read.
// It must be able to read the top-up presets and price a top-up, and nothing
// else that wallet:read guards.
func TestWalletWriteCanReadTopupInfoOnly(t *testing.T) {
	helper := []string{"api_key:read", "api_key:reveal", "api_key:write", "profile:read", "usage:read", "wallet:write"}
	for _, key := range []string{"GET /api/user/topup/info", "POST /api/user/amount", "POST /api/user/pay"} {
		rule, ok := accessTokenRouteRules[key]
		if !ok || !rule.Granted(helper) {
			t.Fatalf("%s should accept the helper token", key)
		}
	}
	for _, key := range []string{"GET /api/user/aff", "GET /api/user/topup/self"} {
		rule, ok := accessTokenRouteRules[key]
		if !ok || rule.Granted(helper) {
			t.Fatalf("%s should still need wallet:read", key)
		}
	}
	if !accessTokenRouteRules["GET /api/user/topup/info"].Granted([]string{"wallet:read"}) {
		t.Fatal("wallet:read alone must keep working")
	}
	if accessTokenScopeRule("wallet:read").Granted(nil) || accessTokenScopeOrRule("wallet:read", "wallet:write").Granted([]string{"usage:read"}) {
		t.Fatal("no scope, no access")
	}
}
