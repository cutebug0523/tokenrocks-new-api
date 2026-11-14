package middleware

import (
	"net/http"
	"strconv"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 同一个人的几个号：各号自己的上限照旧，另外合计不超过共享额度；名单外的号不受影响。
func TestSharedRateLimitCapsAccountsTogether(t *testing.T) {
	require.NoError(t, i18n.Init())
	gs := operation_setting.GetGeneralSetting()
	prev := []any{setting.ModelRequestRateLimitEnabled, setting.ModelRequestRateLimitCount, setting.ModelRequestRateLimitSuccessCount, gs.SharedRateLimits}
	t.Cleanup(func() {
		setting.ModelRequestRateLimitEnabled, setting.ModelRequestRateLimitCount = prev[0].(bool), prev[1].(int)
		setting.ModelRequestRateLimitSuccessCount = prev[2].(int)
		gs.SharedRateLimits = prev[3].([]operation_setting.SharedRateLimit)
	})
	for _, backend := range []string{"memory", "redis"} {
		t.Run(backend, func(t *testing.T) {
			if backend == "redis" {
				useRateLimitMiniRedis(t)
			} else {
				prevRedis := common.RedisEnabled
				common.RedisEnabled = false
				t.Cleanup(func() { common.RedisEnabled = prevRedis })
			}
			base := 7300000 + int(modelRateLimitTestUsers.Add(10))
			a, b, other := base, base+1, base+2
			setting.ModelRequestRateLimitEnabled, setting.ModelRequestRateLimitCount, setting.ModelRequestRateLimitSuccessCount = true, 2, 1000
			gs.SharedRateLimits = []operation_setting.SharedRateLimit{{UserIds: []int{a, b}, Count: 3}}
			router := gin.New()
			router.GET("/:uid", func(c *gin.Context) { id, _ := strconv.Atoi(c.Param("uid")); c.Set("id", id) }, ModelRequestRateLimit(), func(c *gin.Context) { c.Status(http.StatusOK) })
			hit := func(uid int) int {
				return performRateLimitRequest(router, "/"+strconv.Itoa(uid), "127.0.0.1:1000").Code
			}
			assert.Equal(t, http.StatusOK, hit(a))
			assert.Equal(t, http.StatusOK, hit(a))
			assert.Equal(t, http.StatusTooManyRequests, hit(a), "a 自己的上限 2")
			assert.Equal(t, http.StatusOK, hit(b), "合计第 3 次")
			assert.Equal(t, http.StatusTooManyRequests, hit(b), "b 自己才 1 次，但合计到了 3")
			assert.Equal(t, http.StatusOK, hit(other), "名单外的号不受合计限流影响")
			assert.Equal(t, http.StatusOK, hit(other))
		})
	}
}
