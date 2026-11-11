package operation_setting

import "github.com/QuantumNous/new-api/setting/config"

type PaymentSetting struct {
	AmountOptions  []int           `json:"amount_options"`
	AmountDiscount map[int]float64 `json:"amount_discount"` // 充值金额对应的折扣，例如 100 元 0.9 表示 100 元充值享受 9 折优惠
	// FirstTopUpBonus 是每个用户第一笔在线充值额外送的额度，单位同充值金额（人民币显示时是元），0 表示不送（TokenRocks 改动）
	FirstTopUpBonus int `json:"first_topup_bonus"`
	// DistributorUsers 是分销商名单：用户 id → 分销编号（几号）。只有名单里的人能打开 /distributor 买码（TokenRocks 改动）
	DistributorUsers map[int]int `json:"distributor_users"`
	// DistributorParents 是分销商的上级：下级编号 → 上级编号。上级另拿下级那边充值的 5%（TokenRocks 改动）
	DistributorParents map[int]int `json:"distributor_parents"`
	// DistributorFaceValues 是分销商在线买码能选的面额，单位元（TokenRocks 改动）
	DistributorFaceValues []int `json:"distributor_face_values"`
	// DistributorPayouts 是给分销商的打款记录：编号 → 每笔对公转账，打完款手记一笔，分销后台的「已提现」就是它的合计（TokenRocks 改动）
	DistributorPayouts map[int][]DistributorPayout `json:"distributor_payouts"`

	ComplianceConfirmed    bool   `json:"compliance_confirmed"`
	ComplianceTermsVersion string `json:"compliance_terms_version"`
	ComplianceConfirmedAt  int64  `json:"compliance_confirmed_at"`
	ComplianceConfirmedBy  int    `json:"compliance_confirmed_by"`
	ComplianceConfirmedIP  string `json:"compliance_confirmed_ip"`
}

// DistributorPayout 是给分销商打的一笔款，Date 是北京时间 2006-01-02，Amount 单位元。
type DistributorPayout struct {
	Date   string  `json:"date"`
	Amount float64 `json:"amount"`
}

const CurrentComplianceTermsVersion = "v1"

// 默认配置
var paymentSetting = PaymentSetting{
	AmountOptions:         []int{10, 20, 50, 100, 200, 500},
	AmountDiscount:        map[int]float64{},
	DistributorUsers:      map[int]int{},
	DistributorParents:    map[int]int{},
	DistributorFaceValues: []int{1, 2, 5},
	DistributorPayouts:    map[int][]DistributorPayout{},
}

func init() {
	// 注册到全局配置管理器
	config.GlobalConfig.Register("payment_setting", &paymentSetting)
}

func GetPaymentSetting() *PaymentSetting {
	return &paymentSetting
}

func IsPaymentComplianceConfirmed() bool {
	return paymentSetting.ComplianceConfirmed &&
		paymentSetting.ComplianceTermsVersion == CurrentComplianceTermsVersion
}
