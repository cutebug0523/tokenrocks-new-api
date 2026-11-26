package common

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func useVerificationMiniRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	previousRedisEnabled := RedisEnabled
	previousRedisClient := RDB
	redisServer := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	require.NoError(t, redisClient.Ping(context.Background()).Err())
	RedisEnabled = true
	RDB = redisClient
	t.Cleanup(func() {
		_ = redisClient.Close()
		RedisEnabled = previousRedisEnabled
		RDB = previousRedisClient
	})
	return redisServer
}

// forgetLocalVerificationCodes stands in for another gateway node, which
// shares Redis but not this process's memory.
func forgetLocalVerificationCodes() {
	verificationMutex.Lock()
	defer verificationMutex.Unlock()
	verificationMap = make(map[string]verificationValue)
}

func TestVerificationCodeIsSharedThroughRedis(t *testing.T) {
	redisServer := useVerificationMiniRedis(t)
	email := "user@example.com"

	RegisterVerificationCodeWithKey(email, "reset-code", PasswordResetPurpose)
	forgetLocalVerificationCodes()

	assert.True(t, VerifyCodeWithKey(email, "reset-code", PasswordResetPurpose))
	assert.False(t, VerifyCodeWithKey(email, "wrong-code", PasswordResetPurpose))
	assert.False(t, VerifyCodeWithKey(email, "reset-code", EmailVerificationPurpose))

	DeleteKey(email, PasswordResetPurpose)
	assert.False(t, VerifyCodeWithKey(email, "reset-code", PasswordResetPurpose), "a used code must not verify again")

	RegisterVerificationCodeWithKey(email, "signup-code", EmailVerificationPurpose)
	redisServer.FastForward(time.Duration(VerificationValidMinutes) * time.Minute)
	assert.False(t, VerifyCodeWithKey(email, "signup-code", EmailVerificationPurpose), "an expired code must not verify")
}

func TestVerificationCodeWithoutRedisStaysInMemory(t *testing.T) {
	previousRedisEnabled := RedisEnabled
	RedisEnabled = false
	t.Cleanup(func() { RedisEnabled = previousRedisEnabled })
	email := "local@example.com"

	RegisterVerificationCodeWithKey(email, "local-code", PasswordResetPurpose)
	assert.True(t, VerifyCodeWithKey(email, "local-code", PasswordResetPurpose))

	DeleteKey(email, PasswordResetPurpose)
	assert.False(t, VerifyCodeWithKey(email, "local-code", PasswordResetPurpose))
}
