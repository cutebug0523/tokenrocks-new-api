package service

import (
	"context"
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

// TokenRocks: a user whose streamed output passes
// general_setting.non_stream_auto_output_tokens within one 10-minute window is
// a bulk client. Their streaming requests go upstream as non-streaming for the
// next 24 hours, renewed while they stay above the limit, so each reply
// crosses the shared port once instead of as ~250 bytes of SSE per token.
// ponytail: needs Redis (both TokenRocks nodes share one); without it the switch stays off.
const (
	bulkStreamWindowSeconds = 600
	bulkStreamHold          = 24 * time.Hour
)

func bulkStreamFlagKey(userId int) string {
	return fmt.Sprintf("bulk_stream:on:%d", userId)
}

// ObserveStreamOutput adds the output tokens of one settled streaming request
// to the user's current window and switches the user once the window passes
// the limit.
func ObserveStreamOutput(userId int, outputTokens int64) {
	limit := operation_setting.GetGeneralSetting().NonStreamAutoOutputTokens
	if limit <= 0 || outputTokens <= 0 || !common.RedisEnabled || common.RDB == nil {
		return
	}
	ctx := context.Background()
	key := fmt.Sprintf("bulk_stream:out:%d:%d", userId, time.Now().Unix()/bulkStreamWindowSeconds)
	pipe := common.RDB.TxPipeline()
	total := pipe.IncrBy(ctx, key, outputTokens)
	pipe.Expire(ctx, key, 2*bulkStreamWindowSeconds*time.Second)
	if _, err := pipe.Exec(ctx); err != nil {
		common.SysError(common.LogText("bulk stream counter failed: %s", err.Error()))
		return
	}
	if total.Val() < int64(limit) {
		return
	}
	switched, err := common.RDB.SetNX(ctx, bulkStreamFlagKey(userId), "1", bulkStreamHold).Result()
	if err != nil {
		common.SysError(common.LogText("bulk stream switch failed: %s", err.Error()))
		return
	}
	if switched {
		common.SysLog(common.LogText("user %d streamed %d output tokens in 10 minutes; upstream non-streaming for 24 hours", userId, total.Val()))
		return
	}
	common.RDB.Expire(ctx, bulkStreamFlagKey(userId), bulkStreamHold)
}

// IsBulkStreamUser reports whether ObserveStreamOutput switched the user.
func IsBulkStreamUser(userId int) bool {
	if !common.RedisEnabled || common.RDB == nil {
		return false
	}
	n, err := common.RDB.Exists(context.Background(), bulkStreamFlagKey(userId)).Result()
	return err == nil && n > 0
}
