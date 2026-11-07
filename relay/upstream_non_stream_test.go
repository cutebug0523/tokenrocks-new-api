package relay

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	relaychannel "github.com/QuantumNous/new-api/relay/channel"
	"github.com/QuantumNous/new-api/relay/channel/claude"
	"github.com/QuantumNous/new-api/relay/channel/openai"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

// replayToClient sends an upstream JSON reply through replayUpstreamNonStream
// and the adaptor's stream handler, returning the billed usage and the SSE
// data payloads the client received.
func replayToClient(t *testing.T, info *relaycommon.RelayInfo, adaptor relaychannel.Adaptor, body string) (*dto.Usage, []string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	if constant.StreamingTimeout == 0 {
		constant.StreamingTimeout = 30
	}
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/test", nil)
	resp := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}

	require.Nil(t, replayUpstreamNonStream(info, resp))
	assert.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))
	usage, apiErr := adaptor.DoResponse(c, resp, info)
	require.Nil(t, apiErr)

	var payloads []string
	for line := range strings.SplitSeq(recorder.Body.String(), "\n") {
		if payload, ok := strings.CutPrefix(line, "data: "); ok {
			payloads = append(payloads, payload)
		}
	}
	return usage.(*dto.Usage), payloads
}

func eventTypes(payloads []string) []string {
	names := make([]string, 0, len(payloads))
	for _, payload := range payloads {
		names = append(names, gjson.Get(payload, "type").String())
	}
	return names
}

func TestUpstreamNonStreamChatReplayToOpenAIClient(t *testing.T) {
	info := &relaycommon.RelayInfo{
		IsStream: true, RelayFormat: types.RelayFormatOpenAI, RelayMode: relayconstant.RelayModeChatCompletions,
		ShouldIncludeUsage: true, UpstreamNonStreamFormat: types.RelayFormatOpenAI, ChannelMeta: &relaycommon.ChannelMeta{},
	}
	body := `{"id":"r1","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"hello","reasoning_content":"think","tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`

	usage, payloads := replayToClient(t, info, &openai.Adaptor{}, body)

	assert.Equal(t, 11, usage.PromptTokens)
	assert.Equal(t, 7, usage.CompletionTokens)
	require.Len(t, payloads, 6, payloads)
	assert.Equal(t, "assistant", gjson.Get(payloads[0], "choices.0.delta.role").String())
	assert.Equal(t, "think", gjson.Get(payloads[0], "choices.0.delta.reasoning_content").String())
	assert.Equal(t, "hello", gjson.Get(payloads[1], "choices.0.delta.content").String())
	assert.Equal(t, "f", gjson.Get(payloads[2], "choices.0.delta.tool_calls.0.function.name").String())
	assert.Equal(t, int64(0), gjson.Get(payloads[2], "choices.0.delta.tool_calls.0.index").Int())
	assert.Equal(t, "tool_calls", gjson.Get(payloads[3], "choices.0.finish_reason").String())
	assert.Equal(t, int64(18), gjson.Get(payloads[4], "usage.total_tokens").Int())
	assert.Equal(t, "[DONE]", payloads[5])
}

func TestUpstreamNonStreamChatReplayToClaudeClient(t *testing.T) {
	info := &relaycommon.RelayInfo{
		IsStream: true, RelayFormat: types.RelayFormatClaude, RelayMode: relayconstant.RelayModeChatCompletions,
		UpstreamNonStreamFormat: types.RelayFormatOpenAI, ChannelMeta: &relaycommon.ChannelMeta{},
	}
	body := `{"id":"r1","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"hello","tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{\"a\":1}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`

	usage, payloads := replayToClient(t, info, &openai.Adaptor{}, body)

	assert.Equal(t, 7, usage.CompletionTokens)
	events := eventTypes(payloads)
	assert.Equal(t, "message_start", events[0])
	assert.Equal(t, "message_stop", events[len(events)-1])
	var text, toolName, toolInput string
	for _, payload := range payloads {
		text += gjson.Get(payload, "delta.text").String()
		toolInput += gjson.Get(payload, "delta.partial_json").String()
		if name := gjson.Get(payload, "content_block.name").String(); name != "" {
			toolName = name
		}
	}
	assert.Equal(t, "hello", text)
	assert.Equal(t, "f", toolName)
	assert.JSONEq(t, `{"a":1}`, toolInput)
	assert.Contains(t, events, "message_delta")
}

func TestUpstreamNonStreamResponsesReplay(t *testing.T) {
	info := &relaycommon.RelayInfo{
		IsStream: true, RelayFormat: types.RelayFormatOpenAIResponses, RelayMode: relayconstant.RelayModeResponses,
		UpstreamNonStreamFormat: types.RelayFormatOpenAIResponses, ChannelMeta: &relaycommon.ChannelMeta{},
	}
	body := `{"id":"resp_1","object":"response","status":"completed","model":"m","instructions":"You are Codex...","output":[` +
		`{"id":"rs_1","type":"reasoning","summary":[],"encrypted_content":"enc"},` +
		`{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"hello <b>","annotations":[]}]},` +
		`{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"f","arguments":"{\"a\":1}"}],` +
		`"usage":{"input_tokens":20,"input_tokens_details":{"cached_tokens":8},"output_tokens":9,"total_tokens":29}}`

	usage, payloads := replayToClient(t, info, &openai.Adaptor{}, body)

	assert.Equal(t, 20, usage.PromptTokens)
	assert.Equal(t, 8, usage.PromptTokensDetails.CachedTokens)
	assert.Equal(t, 9, usage.CompletionTokens)
	assert.Equal(t, []string{
		"response.created",
		"response.output_item.added", "response.output_item.done",
		"response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done",
		"response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done",
		"response.completed",
	}, eventTypes(payloads))
	for i, payload := range payloads {
		assert.Equal(t, int64(i), gjson.Get(payload, "sequence_number").Int())
	}
	assert.Equal(t, "in_progress", gjson.Get(payloads[0], "response.status").String())
	assert.Empty(t, gjson.Get(payloads[0], "response.output").Array())
	assert.Equal(t, "enc", gjson.Get(payloads[2], "item.encrypted_content").String())
	assert.Empty(t, gjson.Get(payloads[3], "item.content").Array())
	assert.Equal(t, "hello <b>", gjson.Get(payloads[5], "delta").String())
	assert.Equal(t, "msg_1", gjson.Get(payloads[5], "item_id").String())
	assert.Equal(t, int64(1), gjson.Get(payloads[5], "output_index").Int())
	assert.Equal(t, "", gjson.Get(payloads[9], "item.arguments").String())
	assert.Equal(t, `{"a":1}`, gjson.Get(payloads[10], "delta").String())
	assert.Equal(t, "resp_1", gjson.Get(payloads[13], "response.id").String())
	assert.Equal(t, gjson.Null, gjson.Get(payloads[0], "response.instructions").Type)
	assert.Equal(t, gjson.Null, gjson.Get(payloads[13], "response.instructions").Type)
	assert.Equal(t, int64(29), gjson.Get(payloads[13], "response.usage.total_tokens").Int())
}

func TestUpstreamNonStreamClaudeReplay(t *testing.T) {
	info := &relaycommon.RelayInfo{
		IsStream: true, RelayFormat: types.RelayFormatClaude,
		UpstreamNonStreamFormat: types.RelayFormatClaude, ChannelMeta: &relaycommon.ChannelMeta{},
	}
	body := `{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[` +
		`{"type":"thinking","thinking":"hmm","signature":"sig"},` +
		`{"type":"text","text":"hi"},` +
		`{"type":"tool_use","id":"tu_1","name":"get","input":{"q":1}}],` +
		`"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":0}}`

	usage, payloads := replayToClient(t, info, &claude.Adaptor{}, body)

	assert.Equal(t, 10, usage.PromptTokens)
	assert.Equal(t, 3, usage.PromptTokensDetails.CachedTokens)
	assert.Equal(t, 5, usage.CompletionTokens)
	assert.Equal(t, []string{
		"message_start",
		"content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
		"content_block_start", "content_block_delta", "content_block_stop",
		"content_block_start", "content_block_delta", "content_block_stop",
		"message_delta", "message_stop",
	}, eventTypes(payloads))
	assert.Empty(t, gjson.Get(payloads[0], "message.content").Array())
	assert.Equal(t, "hmm", gjson.Get(payloads[2], "delta.thinking").String())
	assert.Equal(t, "sig", gjson.Get(payloads[3], "delta.signature").String())
	assert.Equal(t, "hi", gjson.Get(payloads[6], "delta.text").String())
	assert.JSONEq(t, `{}`, gjson.Get(payloads[8], "content_block.input").Raw)
	assert.JSONEq(t, `{"q":1}`, gjson.Get(payloads[9], "delta.partial_json").String())
	assert.Equal(t, "tool_use", gjson.Get(payloads[11], "delta.stop_reason").String())
	assert.Equal(t, int64(5), gjson.Get(payloads[11], "usage.output_tokens").Int())
}

func TestUpstreamNonStreamErrorReplyIsRetryable(t *testing.T) {
	for _, tc := range []struct {
		format types.RelayFormat
		body   string
	}{
		{types.RelayFormatOpenAI, `{"error":{"type":"server_error","message":"overloaded"}}`},
		{types.RelayFormatOpenAIResponses, `{"error":{"type":"server_error","message":"overloaded"}}`},
		{types.RelayFormatClaude, `{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}`},
	} {
		info := &relaycommon.RelayInfo{UpstreamNonStreamFormat: tc.format}
		resp := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(tc.body))}
		apiErr := replayUpstreamNonStream(info, resp)
		require.NotNil(t, apiErr, tc.format)
		assert.Contains(t, apiErr.Error(), "overloaded", tc.format)
	}
}

func TestPrepareUpstreamNonStream(t *testing.T) {
	chat := &dto.GeneralOpenAIRequest{Stream: common.GetPointer(true), StreamOptions: &dto.StreamOptions{IncludeUsage: true}}
	info := &relaycommon.RelayInfo{UpstreamNonStream: true, ChannelMeta: &relaycommon.ChannelMeta{ApiType: constant.APITypeOpenAI}}
	prepareUpstreamNonStream(info, chat)
	assert.False(t, *chat.Stream)
	assert.Nil(t, chat.StreamOptions)
	assert.EqualValues(t, types.RelayFormatOpenAI, info.UpstreamNonStreamFormat)

	info = &relaycommon.RelayInfo{UpstreamNonStream: true, ChannelMeta: &relaycommon.ChannelMeta{ApiType: constant.APITypeOpenAI}}
	responses := prepareUpstreamNonStream(info, dto.OpenAIResponsesRequest{Stream: common.GetPointer(true)}).(dto.OpenAIResponsesRequest)
	assert.False(t, *responses.Stream)
	assert.EqualValues(t, types.RelayFormatOpenAIResponses, info.UpstreamNonStreamFormat)

	info = &relaycommon.RelayInfo{UpstreamNonStream: true, ChannelMeta: &relaycommon.ChannelMeta{ApiType: constant.APITypeAnthropic}}
	claudeRequest := &dto.ClaudeRequest{Stream: common.GetPointer(true)}
	prepareUpstreamNonStream(info, claudeRequest)
	assert.False(t, *claudeRequest.Stream)
	assert.EqualValues(t, types.RelayFormatClaude, info.UpstreamNonStreamFormat)

	// Protocols without a replay and channels outside OpenAI/Advanced Custom/Anthropic keep streaming.
	info = &relaycommon.RelayInfo{UpstreamNonStream: true, ChannelMeta: &relaycommon.ChannelMeta{ApiType: constant.APITypeOpenAI}}
	prepareUpstreamNonStream(info, &dto.GeminiChatRequest{})
	assert.Empty(t, info.UpstreamNonStreamFormat)
	info = &relaycommon.RelayInfo{UpstreamNonStream: true, ChannelMeta: &relaycommon.ChannelMeta{ApiType: constant.APITypeGemini}}
	chat = &dto.GeneralOpenAIRequest{Stream: common.GetPointer(true)}
	prepareUpstreamNonStream(info, chat)
	assert.True(t, *chat.Stream)
	assert.Empty(t, info.UpstreamNonStreamFormat)
}

func TestBulkStreamUserSwitchesAfterWindowLimit(t *testing.T) {
	redisServer := miniredis.RunT(t)
	previousEnabled, previousClient := common.RedisEnabled, common.RDB
	settings := operation_setting.GetGeneralSetting()
	previousLimit := settings.NonStreamAutoOutputTokens
	t.Cleanup(func() {
		common.RedisEnabled, common.RDB = previousEnabled, previousClient
		settings.NonStreamAutoOutputTokens = previousLimit
	})
	common.RedisEnabled = true
	common.RDB = redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	settings.NonStreamAutoOutputTokens = 100

	service.ObserveStreamOutput(7, 60)
	assert.False(t, service.IsBulkStreamUser(7))
	service.ObserveStreamOutput(8, 60)
	assert.False(t, service.IsBulkStreamUser(8), "windows are per user")
	service.ObserveStreamOutput(7, 40)
	assert.True(t, service.IsBulkStreamUser(7))
	assert.InDelta(t, 24*3600, redisServer.TTL("bulk_stream:on:7").Seconds(), 1)

	settings.NonStreamAutoOutputTokens = 0
	service.ObserveStreamOutput(8, 1000)
	assert.False(t, service.IsBulkStreamUser(8), "0 turns the switch off")
}

func TestUpstreamNonStreamReplayDecidesByBody(t *testing.T) {
	info := &relaycommon.RelayInfo{UpstreamNonStreamFormat: types.RelayFormatOpenAIResponses}
	labelledSSE := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"text/event-stream"}},
		Body: io.NopCloser(strings.NewReader("\n {\"id\":\"resp_1\",\"object\":\"response\",\"status\":\"completed\",\"output\":[]}"))}
	require.Nil(t, replayUpstreamNonStream(info, labelledSSE))
	replayed, err := io.ReadAll(labelledSSE.Body)
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(string(replayed), "data: "), string(replayed))
	assert.Contains(t, string(replayed), "response.completed")

	stream := "data: {\"type\":\"response.created\"}\n\n"
	realSSE := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(stream))}
	require.Nil(t, replayUpstreamNonStream(info, realSSE))
	passed, err := io.ReadAll(realSSE.Body)
	require.NoError(t, err)
	assert.Equal(t, stream, string(passed))
}
