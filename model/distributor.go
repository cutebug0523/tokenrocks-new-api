package model

import (
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// TokenRocks 改动：分销商在线买兑换码。
// 付款回调和充值共用易支付回调地址，订单号以 DistributorTradeNoPrefix 开头的走这里：
// 只按面额生成兑换码，不加余额、不送首充、不给邀请返佣。

// DistributorTradeNoPrefix 是分销买码订单号的前缀，充值订单号是 USR 开头。
const DistributorTradeNoPrefix = "FX"

// DistributorCommissionRate 是分销商的人在线充值返给分销商的比例，按实付算，现金月结。
const DistributorCommissionRate = 0.1

type DistributorOrder struct {
	Id            int     `json:"id"`
	UserId        int     `json:"user_id" gorm:"index"`
	DistributorNo int     `json:"distributor_no"`
	TradeNo       string  `json:"trade_no" gorm:"type:varchar(255);uniqueIndex"`
	FaceValue     int     `json:"face_value"`
	Count         int     `json:"count"`
	Money         float64 `json:"money"`
	PaymentMethod string  `json:"payment_method" gorm:"type:varchar(50)"`
	BatchName     string  `json:"batch_name" gorm:"type:varchar(64)"`
	Status        string  `json:"status" gorm:"type:varchar(32)"`
	CreateTime    int64   `json:"create_time"`
	CompleteTime  int64   `json:"complete_time"`
}

// distributorZone 是分销批次名里的日期和月结用的时区（北京时间）。
var distributorZone = time.FixedZone("CST", 8*3600)

// DistributorBatchPrefix 是某个分销商所有兑换码批次名的共同前缀，月结和统计都按它认码。
func DistributorBatchPrefix(no int) string {
	return fmt.Sprintf("分销-%d号-", no)
}

// FulfillDistributorOrder 原子完成分销买码订单：订单行锁、状态校验、生成兑换码、更新订单在同一事务里，
// 同一订单的重复或并发回调最多出一批码。alreadyDone=true 表示之前已经出过码。
func FulfillDistributorOrder(tradeNo string, actualPaymentMethod string) (alreadyDone bool, err error) {
	if tradeNo == "" {
		return false, errors.New("payment order number not provided")
	}
	order := &DistributorOrder{}
	err = DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where(&DistributorOrder{TradeNo: tradeNo}).First(order).Error; err != nil {
			return ErrTopUpNotFound
		}
		if order.Status == common.TopUpStatusSuccess {
			alreadyDone = true
			return nil
		}
		if order.Status != common.TopUpStatusPending {
			return ErrTopUpStatusInvalid
		}
		quota, quotaErr := EpayTopUpQuota(int64(order.FaceValue))
		if quotaErr != nil || quota <= 0 {
			return ErrInvalidTopUpQuota
		}
		now := common.GetTimestamp()
		order.BatchName = fmt.Sprintf("%s%s-%d", DistributorBatchPrefix(order.DistributorNo), time.Unix(now, 0).In(distributorZone).Format("0102"), order.Id)
		codes := make([]Redemption, order.Count)
		for i := range codes {
			codes[i] = Redemption{
				UserId:      order.UserId,
				Key:         common.GetUUID(),
				Status:      common.RedemptionCodeStatusEnabled,
				Name:        order.BatchName,
				Quota:       quota,
				CreatedTime: now,
			}
		}
		if err := tx.Create(&codes).Error; err != nil {
			return err
		}
		if actualPaymentMethod != "" {
			order.PaymentMethod = actualPaymentMethod
		}
		order.Status = common.TopUpStatusSuccess
		order.CompleteTime = now
		return tx.Save(order).Error
	})
	if err != nil {
		if !errors.Is(err, ErrTopUpNotFound) && !errors.Is(err, ErrTopUpStatusInvalid) {
			common.SysError(common.LogText("distributor order failed: %s", err.Error()))
		}
		return false, err
	}
	if !alreadyDone {
		common.SysLog(common.LogText("Distributor order paid trade_no=%s user_id=%d batch=%s count=%d money=%.2f", order.TradeNo, order.UserId, order.BatchName, order.Count, order.Money))
	}
	return alreadyDone, nil
}

// GetDistributorOrders 返回用户最近的买码订单，新的在前。
func GetDistributorOrders(userId int, limit int) ([]DistributorOrder, error) {
	var orders []DistributorOrder
	err := DB.Where("user_id = ?", userId).Order("id desc").Limit(limit).Find(&orders).Error
	return orders, err
}

// GetPaidDistributorOrders 返回所有已付款的买码订单，记账用。
func GetPaidDistributorOrders(since int64) ([]DistributorOrder, error) {
	var orders []DistributorOrder
	err := DB.Where("status = ? AND complete_time >= ?", common.TopUpStatusSuccess, since).Order("id").Find(&orders).Error
	return orders, err
}

// GetDistributorOrderCodes 返回用户自己一笔已付款订单的兑换码，订单不是他的或没付款时报 ErrTopUpNotFound。
func GetDistributorOrderCodes(userId int, orderId int) (*DistributorOrder, []string, error) {
	order := &DistributorOrder{}
	if err := DB.Where("id = ? AND user_id = ? AND status = ?", orderId, userId, common.TopUpStatusSuccess).First(order).Error; err != nil {
		return nil, nil, ErrTopUpNotFound
	}
	var keys []string
	err := DB.Model(&Redemption{}).Where("name = ?", order.BatchName).Order("id").Pluck("key", &keys).Error
	return order, keys, err
}

type DistributorMonth struct {
	Month      string  `json:"month"`
	Count      int     `json:"count"`
	Money      float64 `json:"money"`
	Commission float64 `json:"commission"`
}

type DistributorStats struct {
	CodesTotal    int64              `json:"codes_total"`
	CodesRedeemed int64              `json:"codes_redeemed"`
	Users         int                `json:"users"`
	Months        []DistributorMonth `json:"months"`
}

// GetDistributorStats 算分销商的合计，口径和 中转/分销月结.sh 一样：
// 用户兑的第一张码是他的就算他的人；兑码前 24 小时以外就充过值的不算；
// 兑码前 24 小时起的成功充值都算，按北京时间分本月、上月。退款这里看不到，月结时扣。
func GetDistributorStats(no int, now time.Time) (*DistributorStats, error) {
	prefix := DistributorBatchPrefix(no) + "%"
	stats := &DistributorStats{}
	// 作废的码不算，但作废前已经兑掉的照算（兑换码是软删除，所以要 Unscoped）
	if err := DB.Unscoped().Model(&Redemption{}).Where("name LIKE ? AND (deleted_at IS NULL OR used_user_id > 0)", prefix).Count(&stats.CodesTotal).Error; err != nil {
		return nil, err
	}
	if err := DB.Unscoped().Model(&Redemption{}).Where("name LIKE ? AND used_user_id > 0", prefix).Count(&stats.CodesRedeemed).Error; err != nil {
		return nil, err
	}

	type firstUse struct {
		UserId int
		T      int64
	}
	var his []firstUse
	if err := DB.Unscoped().Model(&Redemption{}).Select("used_user_id AS user_id, MIN(redeemed_time) AS t").
		Where("name LIKE ? AND used_user_id > 0", prefix).Group("used_user_id").Scan(&his).Error; err != nil {
		return nil, err
	}
	since := make(map[int]int64, len(his))
	ids := make([]int, 0, len(his))
	for _, h := range his {
		since[h.UserId] = h.T
		ids = append(ids, h.UserId)
	}

	start := time.Date(now.In(distributorZone).Year(), now.In(distributorZone).Month(), 1, 0, 0, 0, 0, distributorZone)
	lastStart := start.AddDate(0, -1, 0)
	stats.Months = []DistributorMonth{{Month: start.Format("2006-01")}, {Month: lastStart.Format("2006-01")}}
	if len(ids) == 0 {
		return stats, nil
	}

	// ponytail: 名单整个塞进 IN，他的人上万再分批
	var first []firstUse
	if err := DB.Unscoped().Model(&Redemption{}).Select("used_user_id AS user_id, MIN(redeemed_time) AS t").
		Where("used_user_id IN ?", ids).Group("used_user_id").Scan(&first).Error; err != nil {
		return nil, err
	}
	var paidFirst []firstUse
	if err := DB.Model(&TopUp{}).Select("user_id, MIN(complete_time) AS t").
		Where("user_id IN ? AND status = ?", ids, common.TopUpStatusSuccess).Group("user_id").Scan(&paidFirst).Error; err != nil {
		return nil, err
	}
	firstPaid := make(map[int]int64, len(paidFirst))
	for _, p := range paidFirst {
		firstPaid[p.UserId] = p.T
	}
	mine := make([]int, 0, len(first))
	for _, f := range first {
		s := since[f.UserId]
		if f.T != s {
			continue
		}
		if t, ok := firstPaid[f.UserId]; ok && t < s-86400 {
			continue
		}
		mine = append(mine, f.UserId)
	}
	stats.Users = len(mine)
	if len(mine) == 0 {
		return stats, nil
	}

	var topUps []TopUp
	if err := DB.Select("user_id", "money", "complete_time").
		Where("user_id IN ? AND status = ? AND complete_time >= ? AND complete_time < ?", mine, common.TopUpStatusSuccess, lastStart.Unix(), start.AddDate(0, 1, 0).Unix()).
		Find(&topUps).Error; err != nil {
		return nil, err
	}
	for _, t := range topUps {
		if t.CompleteTime < since[t.UserId]-86400 {
			continue
		}
		m := &stats.Months[1]
		if t.CompleteTime >= start.Unix() {
			m = &stats.Months[0]
		}
		m.Count++
		m.Money += t.Money
	}
	for i := range stats.Months {
		stats.Months[i].Money = math.Round(stats.Months[i].Money*100) / 100
		stats.Months[i].Commission = math.Round(stats.Months[i].Money*DistributorCommissionRate*100) / 100
	}
	return stats, nil
}
