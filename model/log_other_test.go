package model

import (
	"testing"

	"github.com/QuantumNous/new-api/i18n"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLogOtherScopesAndMerges(t *testing.T) {
	var other LogOther

	assert.True(t, other.SetPublic("request_path", "/v1/chat/completions"))
	other.MergePublic(map[string]any{
		"zero": 0,
	})
	assert.True(t, other.SetAdmin("use_channel", []string{"channel-a"}))
	other.MergeAdmin(map[string]any{
		"rejected": false,
	})
	assert.True(t, other.SetRoot("upstream_request_id", "upstream-private"))
	other.MergeRoot(map[string]any{
		"generation": 0,
	})
	assert.True(t, other.SetAudit("method", "POST"))
	other.MergeAudit(map[string]any{
		"success": false,
	})

	require.JSONEq(t, `{
		"request_path": "/v1/chat/completions",
		"zero": 0,
		"admin_info": {
			"use_channel": ["channel-a"],
			"rejected": false
		},
		"root_info": {
			"upstream_request_id": "upstream-private",
			"generation": 0
		},
		"audit_info": {
			"method": "POST",
			"success": false
		}
	}`, other.JSONString())
}

func TestLogOtherRejectsSensitivePublicFields(t *testing.T) {
	other := NewLogOther()

	for _, key := range []string{
		"admin_info",
		"root_info",
		"audit_info",
		"channel_id",
		"channel_name",
		"channel_type",
		"reject_reason",
	} {
		assert.False(t, other.SetPublic(key, "must-not-leak"), key)
	}
	other.MergePublic(map[string]any{
		"request_path": "/v1/responses",
		"channel_name": "still-must-not-leak",
		"admin_info":   map[string]any{"secret": true},
	})

	require.JSONEq(t, `{"request_path":"/v1/responses"}`, other.JSONString())
	require.JSONEq(t, `{}`, NewLogOther().JSONString())
}

func TestLogOtherJSONStringDoesNotMutateReceiver(t *testing.T) {
	other := NewLogOther()
	require.True(t, other.SetPublic("request_path", "/v1/chat/completions"))
	require.True(t, other.SetAdmin("rejected", false))

	before := other.Snapshot()
	first := other.JSONString()
	after := other.Snapshot()
	second := other.JSONString()

	require.Equal(t, before, after)
	require.Equal(t, first, second)
}

func TestFormatUserLogsHidesUpstreamIdentity(t *testing.T) {
	require.NoError(t, i18n.Init())
	upstream := &Log{
		Type:              LogTypeError,
		Content:           "status_code=503, 订阅池内商家当前全部不可用。请开启平台兜底",
		UpstreamRequestId: "a6-request-id",
		Other:             `{"error_type":"openai_error","error_code":"pool_exhausted","status_code":503,"upstream_model_name":"deepseek-v4.1-flash-1017","is_model_mapped":true,"response_model":{"returned_model":"deepseek-ai/DeepSeek-V4.1-Flash-1017"},"request_path":"/v1/chat/completions","admin_info":{"use_channel":["16"]}}`,
	}
	local := &Log{
		Type:    LogTypeError,
		Content: "status_code=400, 请求体不是有效的 JSON",
		Other:   `{"error_type":"new_api_error","status_code":400}`,
	}

	formatUserLogs([]*Log{upstream, local}, 0)

	assert.Equal(t, "status_code=503, "+i18n.Translate("", i18n.MsgRelayUpstreamUnavailable), upstream.Content)
	assert.Empty(t, upstream.UpstreamRequestId)
	require.JSONEq(t, `{"error_type":"openai_error","status_code":503,"request_path":"/v1/chat/completions"}`, upstream.Other)
	assert.Equal(t, "status_code=400, 请求体不是有效的 JSON", local.Content)

	admin := []*Log{{Other: `{"upstream_model_name":"deepseek-v4.1-flash-1017","is_model_mapped":true}`}}
	FormatAdminLogs(admin)
	require.JSONEq(t, `{"upstream_model_name":"deepseek-v4.1-flash-1017","is_model_mapped":true}`, admin[0].Other)
}
