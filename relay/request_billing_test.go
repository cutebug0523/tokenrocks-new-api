package relay

import (
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	hosttypes "github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClampMaxOutputToBalance(t *testing.T) {
	database := setupRelayChannelDB(t)
	require.NoError(t, database.AutoMigrate(&model.User{}, &model.UserSubscription{}))
	previousRedis := common.RedisEnabled
	common.RedisEnabled = false
	t.Cleanup(func() { common.RedisEnabled = previousRedis })

	// Input costs 10000 quota; each output token costs 2 (32768 reserved).
	newInfo := func(userQuota int) *relaycommon.RelayInfo {
		user := &model.User{Username: common.GetRandomString(8), AffCode: common.GetRandomString(8), Quota: userQuota, Status: common.UserStatusEnabled}
		require.NoError(t, database.Create(user).Error)
		maxOutput := uint(1_000_000)
		return &relaycommon.RelayInfo{
			UserId:         user.Id,
			TokenUnlimited: true,
			Request:        &dto.OpenAIResponsesRequest{MaxOutputTokens: &maxOutput},
			PriceData: hosttypes.PriceData{
				ModelRatio:               1,
				CompletionRatio:          2,
				GroupRatioInfo:           hosttypes.GroupRatioInfo{GroupRatio: 1},
				QuotaToPreConsume:        10000 + 32768*2,
				ReservedCompletionTokens: 32768,
			},
		}
	}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())

	t.Run("affordable reservation is untouched", func(t *testing.T) {
		info := newInfo(1_000_000)
		clampMaxOutputToBalance(c, info)
		assert.Equal(t, uint(1_000_000), *info.Request.(*dto.OpenAIResponsesRequest).MaxOutputTokens)
		assert.Equal(t, 10000+32768*2, info.PriceData.QuotaToPreConsume)
	})

	t.Run("small wallet gets a lower max output", func(t *testing.T) {
		info := newInfo(30000)
		clampMaxOutputToBalance(c, info)
		assert.Equal(t, uint(10000), *info.Request.(*dto.OpenAIResponsesRequest).MaxOutputTokens)
		assert.Equal(t, 30000, info.PriceData.QuotaToPreConsume)
		assert.Equal(t, 10000, info.PriceData.ReservedCompletionTokens)
	})

	t.Run("wallet below input plus minimum keeps the 402 path", func(t *testing.T) {
		info := newInfo(10000 + minClampedOutputTokens*2 - 1)
		clampMaxOutputToBalance(c, info)
		assert.Equal(t, uint(1_000_000), *info.Request.(*dto.OpenAIResponsesRequest).MaxOutputTokens)
		assert.Equal(t, 10000+32768*2, info.PriceData.QuotaToPreConsume)
	})
}

func TestSetMaxOutputTokens(t *testing.T) {
	one := uint(1)
	chat := &dto.GeneralOpenAIRequest{MaxCompletionTokens: &one}
	require.True(t, setMaxOutputTokens(chat, 2048))
	assert.Equal(t, uint(2048), *chat.MaxCompletionTokens)
	assert.Nil(t, chat.MaxTokens)

	bare := &dto.GeneralOpenAIRequest{}
	require.True(t, setMaxOutputTokens(bare, 2048))
	assert.Equal(t, uint(2048), *bare.MaxTokens)

	claude := &dto.ClaudeRequest{}
	require.True(t, setMaxOutputTokens(claude, 2048))
	assert.Equal(t, uint(2048), *claude.MaxTokens)

	gemini := &dto.GeminiChatRequest{}
	require.True(t, setMaxOutputTokens(gemini, 2048))
	assert.Equal(t, uint(2048), *gemini.GenerationConfig.MaxOutputTokens)

	assert.False(t, setMaxOutputTokens(&dto.ImageRequest{}, 2048))
}
