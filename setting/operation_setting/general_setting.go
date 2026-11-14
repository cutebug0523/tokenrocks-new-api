package operation_setting

import (
	"fmt"
	"slices"

	"github.com/QuantumNous/new-api/setting/config"
)

// 额度展示类型
const (
	QuotaDisplayTypeUSD    = "USD"
	QuotaDisplayTypeCNY    = "CNY"
	QuotaDisplayTypeTokens = "TOKENS"
	QuotaDisplayTypeCustom = "CUSTOM"
)

type GeneralSetting struct {
	DocsLink            string `json:"docs_link"`
	PingIntervalEnabled bool   `json:"ping_interval_enabled"`
	PingIntervalSeconds int    `json:"ping_interval_seconds"`
	// 当前站点额度展示类型：USD / CNY / TOKENS
	QuotaDisplayType string `json:"quota_display_type"`
	// 自定义货币符号，用于 CUSTOM 展示类型
	CustomCurrencySymbol string `json:"custom_currency_symbol"`
	// 自定义货币与美元汇率（1 USD = X Custom）
	CustomCurrencyExchangeRate float64 `json:"custom_currency_exchange_rate"`
	// TokenRocks: streaming chat, Responses and Claude Messages requests from
	// these users are sent upstream as non-streaming and replayed to the
	// client as SSE. Bulk clients that refuse gzip otherwise pull ~250 bytes
	// of SSE per output token.
	NonStreamUpstreamUserIds []int `json:"non_stream_upstream_user_ids"`
	// Users never switched automatically (resellers whose own users watch the stream).
	NonStreamExemptUserIds []int `json:"non_stream_exempt_user_ids"`
	// A user whose streamed output tokens within one 10-minute window reach
	// this many is switched for 24 hours; 0 turns the automatic switch off.
	NonStreamAutoOutputTokens int `json:"non_stream_auto_output_tokens"`
	// TokenRocks: accounts known to be one person share an extra per-window
	// request cap on top of each account's own ModelRequestRateLimitCount.
	SharedRateLimits []SharedRateLimit `json:"shared_rate_limits"`
}

type SharedRateLimit struct {
	UserIds []int `json:"user_ids"`
	Count   int   `json:"count"`
}

// SharedRateLimitFor returns the shared bucket a user belongs to (first match).
func SharedRateLimitFor(userId int) (key string, count int, ok bool) {
	for _, l := range generalSetting.SharedRateLimits {
		if l.Count > 0 && slices.Contains(l.UserIds, userId) {
			return fmt.Sprintf("shared:%v", l.UserIds), l.Count, true
		}
	}
	return "", 0, false
}

// 默认配置
var generalSetting = GeneralSetting{
	DocsLink:                   "https://docs.newapi.pro",
	PingIntervalEnabled:        false,
	PingIntervalSeconds:        60,
	QuotaDisplayType:           QuotaDisplayTypeUSD,
	CustomCurrencySymbol:       "¤",
	CustomCurrencyExchangeRate: 1.0,
	NonStreamAutoOutputTokens:  1000000,
}

func init() {
	// 注册到全局配置管理器
	config.GlobalConfig.Register("general_setting", &generalSetting)
}

func GetGeneralSetting() *GeneralSetting {
	return &generalSetting
}

// IsCurrencyDisplay 是否以货币形式展示（美元或人民币）
func IsCurrencyDisplay() bool {
	return generalSetting.QuotaDisplayType != QuotaDisplayTypeTokens
}

// IsCNYDisplay 是否以人民币展示
func IsCNYDisplay() bool {
	return generalSetting.QuotaDisplayType == QuotaDisplayTypeCNY
}

// GetQuotaDisplayType 返回额度展示类型
func GetQuotaDisplayType() string {
	return generalSetting.QuotaDisplayType
}

// GetCurrencySymbol 返回当前展示类型对应符号
func GetCurrencySymbol() string {
	switch generalSetting.QuotaDisplayType {
	case QuotaDisplayTypeUSD:
		return "$"
	case QuotaDisplayTypeCNY:
		return "¥"
	case QuotaDisplayTypeCustom:
		if generalSetting.CustomCurrencySymbol != "" {
			return generalSetting.CustomCurrencySymbol
		}
		return "¤"
	default:
		return ""
	}
}

// GetUsdToCurrencyRate 返回 1 USD = X <currency> 的 X（TOKENS 不适用）
func GetUsdToCurrencyRate(usdToCny float64) float64 {
	switch generalSetting.QuotaDisplayType {
	case QuotaDisplayTypeUSD:
		return 1
	case QuotaDisplayTypeCNY:
		return usdToCny
	case QuotaDisplayTypeCustom:
		if generalSetting.CustomCurrencyExchangeRate > 0 {
			return generalSetting.CustomCurrencyExchangeRate
		}
		return 1
	default:
		return 1
	}
}
