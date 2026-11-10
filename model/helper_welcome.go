package model

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// HelperWelcome 记下哪个账号领过「用 TR助手送的钱」，每个账号一行，主键保证只送一次。
type HelperWelcome struct {
	UserId    int   `json:"user_id" gorm:"primaryKey;autoIncrement:false"`
	Quota     int   `json:"quota"`
	CreatedAt int64 `json:"created_at"`
}

// GrantHelperWelcome 给第一次用 TR助手登录的账号加一次钱，金额是后台的 checkin_setting.helper_welcome_yuan（元，0 就不送）。
// 已经领过、或者没开，回 0。新老用户都送；老用户的小助手登录还没过期的，小助手打开首页查签到时补上。
func GrantHelperWelcome(userId int) (int, error) {
	yuan := operation_setting.GetCheckinSetting().HelperWelcomeYuan
	rate := operation_setting.USDExchangeRate
	if yuan <= 0 || rate <= 0 || userId <= 0 {
		return 0, nil
	}
	// 按元给额度（¥1 = QuotaPerUnit ÷ 汇率），和分销码一样，不跟着额度显示方式走
	quota, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(yuan)).Mul(decimal.NewFromFloat(common.QuotaPerUnit)).Div(decimal.NewFromFloat(rate)))
	if err != nil || quota <= 0 {
		return 0, err
	}
	granted := false
	err = DB.Transaction(func(tx *gorm.DB) error {
		res := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&HelperWelcome{UserId: userId, Quota: quota, CreatedAt: common.GetTimestamp()})
		if res.Error != nil || res.RowsAffected == 0 {
			return res.Error
		}
		granted = true
		return tx.Model(&User{}).Where("id = ?", userId).Update("quota", gorm.Expr("quota + ?", quota)).Error
	})
	if err != nil || !granted {
		return 0, err
	}
	_ = cacheIncrUserQuota(userId, int64(quota))
	RecordLog(userId, LogTypeSystem, common.NewMessage("TR helper welcome bonus {{quota}}", map[string]any{"quota": logger.FormatQuota(quota)}))
	return quota, nil
}
