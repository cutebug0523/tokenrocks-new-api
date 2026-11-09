package relay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/samber/lo"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// TokenRocks upstream non-streaming (general_setting non_stream_* settings):
// a streaming request is sent upstream with stream=false, and the JSON reply
// is rewritten into the SSE that upstream would have streamed for it. The
// adaptor's ordinary stream handler then relays, converts and bills it, so the
// client sees a normal stream that arrives in one burst.

// prepareUpstreamNonStream turns off upstream streaming on a converted request
// when the user is switched and the request's protocol can be replayed. It
// returns the request to marshal; other protocols keep streaming.
func prepareUpstreamNonStream(info *relaycommon.RelayInfo, request any) any {
	if !info.UpstreamNonStream ||
		(info.ApiType != constant.APITypeOpenAI && info.ApiType != constant.APITypeAdvancedCustom && info.ApiType != constant.APITypeAnthropic) {
		return request
	}
	switch req := request.(type) {
	case *dto.GeneralOpenAIRequest:
		req.Stream = lo.ToPtr(false)
		req.StreamOptions = nil
		info.UpstreamNonStreamFormat = types.RelayFormatOpenAI
	case dto.OpenAIResponsesRequest:
		req.Stream = lo.ToPtr(false)
		req.StreamOptions = nil
		info.UpstreamNonStreamFormat = types.RelayFormatOpenAIResponses
		return req
	case *dto.OpenAIResponsesRequest:
		req.Stream = lo.ToPtr(false)
		req.StreamOptions = nil
		info.UpstreamNonStreamFormat = types.RelayFormatOpenAIResponses
	case *dto.ClaudeRequest:
		req.Stream = lo.ToPtr(false)
		info.UpstreamNonStreamFormat = types.RelayFormatClaude
	}
	return request
}

// replayUpstreamNonStream rewrites a JSON reply to a prepareUpstreamNonStream
// request into SSE in place. An error object in the reply is returned so the
// attempt can be retried; a reply that is already SSE is left alone. The body
// decides, not Content-Type: some Responses upstreams label a JSON reply
// text/event-stream. clientCtx is the client request's context.
func replayUpstreamNonStream(clientCtx context.Context, info *relaycommon.RelayInfo, resp *http.Response) *types.NewAPIError {
	if info.UpstreamNonStreamFormat == "" || resp == nil || resp.Body == nil {
		return nil
	}
	reader := bufio.NewReader(resp.Body)
	for {
		first, err := reader.Peek(1)
		if err != nil || !strings.ContainsRune(" \t\r\n", rune(first[0])) {
			break
		}
		_, _ = reader.Discard(1)
	}
	if first, err := reader.Peek(1); err != nil || first[0] != '{' {
		resp.Body = struct {
			io.Reader
			io.Closer
		}{reader, resp.Body}
		return nil
	}
	body, err := io.ReadAll(reader)
	service.CloseResponseBodyGracefully(resp)
	if err != nil {
		return types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError)
	}
	// The client left while upstream was generating, and upstream charges for
	// the reply anyway. Hand it to the adaptor's non-stream handler, which
	// bills its usage as for any non-stream request; replayed as SSE, the
	// stream handler would stop at the closed connection and bill nothing.
	if clientCtx.Err() != nil {
		info.IsStream = false
		resp.Body = io.NopCloser(bytes.NewReader(body))
		return nil
	}
	var sse []byte
	switch info.UpstreamNonStreamFormat {
	case types.RelayFormatOpenAI:
		var response dto.OpenAITextResponse
		if err := common.Unmarshal(body, &response); err != nil {
			return types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
		}
		if oaiError := response.GetOpenAIError(); oaiError != nil && oaiError.Type != "" {
			return types.WithOpenAIError(*oaiError, resp.StatusCode)
		}
		sse, err = chatResponseAsSSE(&response)
	case types.RelayFormatOpenAIResponses:
		var response dto.OpenAIResponsesResponse
		if err := common.Unmarshal(body, &response); err != nil {
			return types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
		}
		if oaiError := response.GetOpenAIError(); oaiError != nil && oaiError.Type != "" {
			return types.WithOpenAIError(*oaiError, resp.StatusCode)
		}
		sse, err = responsesResponseAsSSE(body)
	case types.RelayFormatClaude:
		var response dto.ClaudeResponse
		if err := common.Unmarshal(body, &response); err != nil {
			return types.NewError(err, types.ErrorCodeBadResponseBody)
		}
		if claudeError := response.GetClaudeError(); claudeError != nil && claudeError.Type != "" {
			return types.WithClaudeError(*claudeError, http.StatusInternalServerError)
		}
		sse, err = claudeResponseAsSSE(body)
	}
	if err != nil {
		return types.NewError(err, types.ErrorCodeBadResponseBody)
	}
	resp.Body = io.NopCloser(bytes.NewReader(sse))
	resp.ContentLength = int64(len(sse))
	resp.Header.Set("Content-Type", "text/event-stream")
	resp.Header.Del("Content-Encoding")
	resp.Header.Del("Content-Length")
	return nil
}

// sseBuffer collects "data:" lines the way upstream streams them.
type sseBuffer struct {
	bytes.Buffer
}

func (b *sseBuffer) data(event any) error {
	payload, err := common.Marshal(event)
	if err != nil {
		return err
	}
	b.WriteString("data: ")
	b.Write(payload)
	b.WriteString("\n\n")
	return nil
}

// chatResponseAsSSE splits a chat completion into the chunks a stream carries:
// reasoning, content, tool calls, finish reason, usage, then [DONE].
func chatResponseAsSSE(response *dto.OpenAITextResponse) ([]byte, error) {
	var out sseBuffer
	chunk := dto.ChatCompletionsStreamResponse{
		Id:      response.Id,
		Object:  "chat.completion.chunk",
		Created: common.GetTimestamp(),
		Model:   response.Model,
	}
	for _, choice := range response.Choices {
		deltas := make([]dto.ChatCompletionsStreamResponseChoiceDelta, 0, 3)
		if lo.FromPtr(choice.Message.ReasoningContent) != "" || lo.FromPtr(choice.Message.Reasoning) != "" {
			deltas = append(deltas, dto.ChatCompletionsStreamResponseChoiceDelta{ReasoningContent: choice.Message.ReasoningContent, Reasoning: choice.Message.Reasoning})
		}
		if content := choice.Message.StringContent(); content != "" {
			delta := dto.ChatCompletionsStreamResponseChoiceDelta{}
			delta.SetContentString(content)
			deltas = append(deltas, delta)
		}
		if len(choice.Message.ToolCalls) > 0 {
			delta := dto.ChatCompletionsStreamResponseChoiceDelta{}
			if err := common.Unmarshal(choice.Message.ToolCalls, &delta.ToolCalls); err != nil {
				return nil, err
			}
			for i := range delta.ToolCalls {
				delta.ToolCalls[i].SetIndex(i)
			}
			deltas = append(deltas, delta)
		}
		deltas = append(deltas, dto.ChatCompletionsStreamResponseChoiceDelta{})
		deltas[0].Role = "assistant"
		for i, delta := range deltas {
			streamChoice := dto.ChatCompletionsStreamResponseChoice{Index: choice.Index, Delta: delta}
			if i == len(deltas)-1 {
				streamChoice.FinishReason = lo.ToPtr(choice.FinishReason)
			}
			chunk.Choices = []dto.ChatCompletionsStreamResponseChoice{streamChoice}
			if err := out.data(chunk); err != nil {
				return nil, err
			}
		}
	}
	if response.Usage.TotalTokens > 0 || response.Usage.PromptTokens > 0 || response.Usage.CompletionTokens > 0 {
		chunk.Choices = []dto.ChatCompletionsStreamResponseChoice{}
		chunk.Usage = &response.Usage
		if err := out.data(chunk); err != nil {
			return nil, err
		}
	}
	out.WriteString("data: [DONE]\n\n")
	return out.Bytes(), nil
}

type responsesReplayEvent struct {
	Type           string          `json:"type"`
	SequenceNumber int             `json:"sequence_number"`
	Response       json.RawMessage `json:"response,omitempty"`
	OutputIndex    *int            `json:"output_index,omitempty"`
	ContentIndex   *int            `json:"content_index,omitempty"`
	ItemID         *string         `json:"item_id,omitempty"`
	Item           json.RawMessage `json:"item,omitempty"`
	Part           json.RawMessage `json:"part,omitempty"`
	Delta          *string         `json:"delta,omitempty"`
	Text           *string         `json:"text,omitempty"`
	Arguments      *string         `json:"arguments,omitempty"`
	Logprobs       json.RawMessage `json:"logprobs,omitempty"`
}

// responsesResponseAsSSE replays a Responses object as response.created, the
// item/part/delta events of each output item, and the terminal event. Items
// other than messages and function calls are sent whole in added and done.
// The echoed instructions are dropped: Codex-backed upstreams return their own
// ~21KB system prompt there, which would otherwise cross the port twice.
func responsesResponseAsSSE(body []byte) ([]byte, error) {
	var out sseBuffer
	events := make([]responsesReplayEvent, 0, 16)
	if gjson.GetBytes(body, "instructions").Exists() {
		body, _ = sjson.SetRawBytes(body, "instructions", []byte("null"))
	}
	created, _ := sjson.SetBytes(body, "status", "in_progress")
	created, _ = sjson.SetRawBytes(created, "output", []byte("[]"))
	created, _ = sjson.SetRawBytes(created, "usage", []byte("null"))
	events = append(events, responsesReplayEvent{Type: "response.created", Response: created})

	for i, item := range gjson.GetBytes(body, "output").Array() {
		outputIndex := lo.ToPtr(i)
		itemID := lo.ToPtr(item.Get("id").String())
		added := item.Raw
		switch item.Get("type").String() {
		case "message":
			added, _ = sjson.SetRaw(added, "content", "[]")
		case "function_call":
			added, _ = sjson.Set(added, "arguments", "")
		}
		if item.Get("status").Exists() {
			added, _ = sjson.Set(added, "status", "in_progress")
		}
		events = append(events, responsesReplayEvent{Type: "response.output_item.added", OutputIndex: outputIndex, Item: json.RawMessage(added)})

		switch item.Get("type").String() {
		case "message":
			for j, part := range item.Get("content").Array() {
				contentIndex := lo.ToPtr(j)
				if part.Get("type").String() != "output_text" {
					events = append(events,
						responsesReplayEvent{Type: "response.content_part.added", OutputIndex: outputIndex, ContentIndex: contentIndex, ItemID: itemID, Part: json.RawMessage(part.Raw)},
						responsesReplayEvent{Type: "response.content_part.done", OutputIndex: outputIndex, ContentIndex: contentIndex, ItemID: itemID, Part: json.RawMessage(part.Raw)},
					)
					continue
				}
				text := lo.ToPtr(part.Get("text").String())
				emptyPart, _ := sjson.Set(part.Raw, "text", "")
				emptyPart, _ = sjson.SetRaw(emptyPart, "annotations", "[]")
				events = append(events,
					responsesReplayEvent{Type: "response.content_part.added", OutputIndex: outputIndex, ContentIndex: contentIndex, ItemID: itemID, Part: json.RawMessage(emptyPart)},
					responsesReplayEvent{Type: "response.output_text.delta", OutputIndex: outputIndex, ContentIndex: contentIndex, ItemID: itemID, Delta: text, Logprobs: json.RawMessage("[]")},
					responsesReplayEvent{Type: "response.output_text.done", OutputIndex: outputIndex, ContentIndex: contentIndex, ItemID: itemID, Text: text, Logprobs: json.RawMessage("[]")},
					responsesReplayEvent{Type: "response.content_part.done", OutputIndex: outputIndex, ContentIndex: contentIndex, ItemID: itemID, Part: json.RawMessage(part.Raw)},
				)
			}
		case "function_call":
			arguments := lo.ToPtr(item.Get("arguments").String())
			events = append(events,
				responsesReplayEvent{Type: "response.function_call_arguments.delta", OutputIndex: outputIndex, ItemID: itemID, Delta: arguments},
				responsesReplayEvent{Type: "response.function_call_arguments.done", OutputIndex: outputIndex, ItemID: itemID, Arguments: arguments},
			)
		}
		events = append(events, responsesReplayEvent{Type: "response.output_item.done", OutputIndex: outputIndex, Item: json.RawMessage(item.Raw)})
	}

	terminal := "response.completed"
	if status := gjson.GetBytes(body, "status").String(); status == "incomplete" || status == "failed" {
		terminal = "response." + status
	}
	events = append(events, responsesReplayEvent{Type: terminal, Response: body})

	for i := range events {
		events[i].SequenceNumber = i
		if err := out.data(events[i]); err != nil {
			return nil, err
		}
	}
	return out.Bytes(), nil
}

type claudeReplayEvent struct {
	Type         string          `json:"type"`
	Message      json.RawMessage `json:"message,omitempty"`
	Index        *int            `json:"index,omitempty"`
	ContentBlock json.RawMessage `json:"content_block,omitempty"`
	Delta        json.RawMessage `json:"delta,omitempty"`
	Usage        json.RawMessage `json:"usage,omitempty"`
}

// claudeResponseAsSSE replays a Claude message as message_start, one
// start/delta/stop group per content block, message_delta and message_stop.
// Blocks without a streaming delta form (search results, redacted thinking)
// are sent whole in content_block_start.
func claudeResponseAsSSE(body []byte) ([]byte, error) {
	var out sseBuffer
	message, _ := sjson.SetRawBytes(body, "content", []byte("[]"))
	message, _ = sjson.SetRawBytes(message, "stop_reason", []byte("null"))
	message, _ = sjson.SetRawBytes(message, "stop_sequence", []byte("null"))
	if err := out.data(claudeReplayEvent{Type: "message_start", Message: message}); err != nil {
		return nil, err
	}

	for i, block := range gjson.GetBytes(body, "content").Array() {
		index := lo.ToPtr(i)
		start := block.Raw
		var deltas []string
		switch block.Get("type").String() {
		case "text":
			start = `{"type":"text","text":""}`
			delta, _ := sjson.Set(`{"type":"text_delta"}`, "text", block.Get("text").String())
			deltas = append(deltas, delta)
		case "thinking":
			start = `{"type":"thinking","thinking":""}`
			delta, _ := sjson.Set(`{"type":"thinking_delta"}`, "thinking", block.Get("thinking").String())
			deltas = append(deltas, delta)
			if signature := block.Get("signature").String(); signature != "" {
				delta, _ = sjson.Set(`{"type":"signature_delta"}`, "signature", signature)
				deltas = append(deltas, delta)
			}
		case "tool_use", "server_tool_use", "mcp_tool_use":
			start, _ = sjson.SetRaw(start, "input", "{}")
			input := block.Get("input").Raw
			if input == "" {
				input = "{}"
			}
			delta, _ := sjson.Set(`{"type":"input_json_delta"}`, "partial_json", input)
			deltas = append(deltas, delta)
		}
		if err := out.data(claudeReplayEvent{Type: "content_block_start", Index: index, ContentBlock: json.RawMessage(start)}); err != nil {
			return nil, err
		}
		for _, delta := range deltas {
			if err := out.data(claudeReplayEvent{Type: "content_block_delta", Index: index, Delta: json.RawMessage(delta)}); err != nil {
				return nil, err
			}
		}
		if err := out.data(claudeReplayEvent{Type: "content_block_stop", Index: index}); err != nil {
			return nil, err
		}
	}

	stop := `{"stop_reason":null,"stop_sequence":null}`
	if reason := gjson.GetBytes(body, "stop_reason"); reason.Exists() {
		stop, _ = sjson.SetRaw(stop, "stop_reason", reason.Raw)
	}
	if sequence := gjson.GetBytes(body, "stop_sequence"); sequence.Exists() {
		stop, _ = sjson.SetRaw(stop, "stop_sequence", sequence.Raw)
	}
	messageDelta := claudeReplayEvent{Type: "message_delta", Delta: json.RawMessage(stop)}
	if usage := gjson.GetBytes(body, "usage"); usage.IsObject() {
		messageDelta.Usage = json.RawMessage(usage.Raw)
	}
	if err := out.data(messageDelta); err != nil {
		return nil, err
	}
	if err := out.data(claudeReplayEvent{Type: "message_stop"}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
