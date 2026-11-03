package openai

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestObserveStreamChoicesDedupesFunctionCallNames(t *testing.T) {
	info := &relaycommon.RelayInfo{StreamStatus: relaycommon.NewStreamStatus()}
	seen := make(map[string]struct{})
	var names []string

	chunks := []string{
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}`,
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"q\":"}}]}}]}`,
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]}}]}`,
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"c2","type":"function","function":{"name":"get_time","arguments":""}}]}}]}`,
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{}"}}]}}]}`,
	}
	for _, chunk := range chunks {
		observeStreamChoices(info, chunk, seen, &names)
	}

	require.Len(t, names, 2)
	assert.Equal(t, []string{"get_weather", "get_time"}, names)
	assert.Empty(t, info.StreamStatus.ResponseOutcome(), "tool call deltas carry no finish reason")

	observeStreamChoices(info, `{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`, seen, &names)
	assert.Equal(t, "completed", info.StreamStatus.ResponseOutcome())
	assert.False(t, info.PerformanceBusinessRejection)

	filtered := &relaycommon.RelayInfo{StreamStatus: relaycommon.NewStreamStatus()}
	observeStreamChoices(filtered, `{"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}`, map[string]struct{}{}, &names)
	assert.True(t, filtered.PerformanceBusinessRejection)
}

func TestNonStreamUpstreamReplyIsSentAsStream(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	info := &relaycommon.RelayInfo{
		IsStream:           true,
		UpstreamNonStream:  true,
		RelayFormat:        types.RelayFormatOpenAI,
		RelayMode:          relayconstant.RelayModeChatCompletions,
		ShouldIncludeUsage: true,
		ChannelMeta:        &relaycommon.ChannelMeta{},
	}
	body := `{"id":"r1","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"hello","reasoning_content":"think","tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`
	resp := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}

	usage, apiErr := (&Adaptor{}).DoResponse(c, resp, info)
	require.Nil(t, apiErr)
	assert.Equal(t, 11, usage.(*dto.Usage).PromptTokens)
	assert.Equal(t, 7, usage.(*dto.Usage).CompletionTokens)

	out := recorder.Body.String()
	assert.Equal(t, "text/event-stream", recorder.Header().Get("Content-Type"))
	events := strings.Split(strings.TrimSpace(out), "\n\n")
	require.Len(t, events, 3, out)
	var first, usageChunk dto.ChatCompletionsStreamResponse
	require.NoError(t, common.Unmarshal([]byte(strings.TrimPrefix(events[0], "data: ")), &first))
	require.Len(t, first.Choices, 1)
	assert.Equal(t, "hello", first.Choices[0].Delta.GetContentString())
	assert.Equal(t, "think", *first.Choices[0].Delta.ReasoningContent)
	require.Len(t, first.Choices[0].Delta.ToolCalls, 1)
	assert.Equal(t, 0, *first.Choices[0].Delta.ToolCalls[0].Index)
	assert.Equal(t, "tool_calls", *first.Choices[0].FinishReason)
	require.NoError(t, common.Unmarshal([]byte(strings.TrimPrefix(events[1], "data: ")), &usageChunk))
	assert.Empty(t, usageChunk.Choices)
	assert.Equal(t, 18, usageChunk.Usage.TotalTokens)
	assert.Equal(t, "data: [DONE]", events[2])
}
