package model

import (
	"cmp"
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

// TokenRocks 改动：分销商在线买兑换码。
// 付款回调和充值共用易支付回调地址，订单号以 DistributorTradeNoPrefix 开头的走这里：
// 只按面额生成兑换码，不加余额、不送首充、不给邀请返佣。

// DistributorTradeNoPrefix 是分销买码订单号的前缀，充值订单号是 USR 开头。
const DistributorTradeNoPrefix = "FX"

// DistributorCommissionRate 是分销商的人在线充值返给分销商的比例，按实付里已经用掉的部分算，对公打款。
const DistributorCommissionRate = 0.1

// DistributorParentCommissionRate 是上级分销商另拿的比例：下级分销商的人在线充值按同样口径再返上级这么多，
// 和下级自己的 10% 分开算。只算直接上级，上级的上级不拿（店主 11-11 定）。谁是谁的上级见 distributorParents。
const DistributorParentCommissionRate = 0.05

// ErrDistributorMoneyMismatch 是付款回调的实付金额和订单金额对不上，不出码。
var ErrDistributorMoneyMismatch = errors.New("distributor order paid amount mismatch")

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
// paidMoney 是付款回调里的实付金额，和订单金额对不上就不出码；后台补单传空串，不核对。
func FulfillDistributorOrder(tradeNo string, actualPaymentMethod string, paidMoney string) (alreadyDone bool, err error) {
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
		if paidMoney != "" {
			paid, parseErr := decimal.NewFromString(paidMoney)
			if parseErr != nil || !paid.Equal(decimal.NewFromFloat(order.Money)) {
				return ErrDistributorMoneyMismatch
			}
		}
		// 码按元给额度（¥1 = QuotaPerUnit ÷ 汇率），不跟着额度显示方式走：显示改成美元也不会多给
		rate := operation_setting.USDExchangeRate
		if rate <= 0 {
			return ErrInvalidTopUpQuota
		}
		quota, quotaErr := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(order.FaceValue)).Mul(decimal.NewFromFloat(common.QuotaPerUnit)).Div(decimal.NewFromFloat(rate)))
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

// GetDistributorOrders 返回用户全部已付款的买码订单和一天内下的没付的，新的在前。
func GetDistributorOrders(userId int, now int64) ([]DistributorOrder, error) {
	var orders []DistributorOrder
	err := DB.Where("user_id = ? AND (status = ? OR create_time > ?)", userId, common.TopUpStatusSuccess, now-86400).Order("id desc").Find(&orders).Error
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
	// 后台手建的批次万一同名，也只拿这个分销商自己的
	err := DB.Model(&Redemption{}).Where("name = ? AND user_id = ?", order.BatchName, order.UserId).Order("id").Pluck("key", &keys).Error
	return order, keys, err
}

type DistributorMonth struct {
	Month string  `json:"month"`
	Count int     `json:"count"`
	Money float64 `json:"money"`
}

// DistributorStats 里的提现四个数（店主 11-11）：返佣只算他的人在线充值里已经用掉的部分，用掉的退不了。
// Paid 是他自己的人累计在线充值（实付）；Pending 是还没用掉那部分的返佣，可能退款，先不结；
// Withdrawable 是已用掉那部分的返佣减去已打款；Withdrawn 是 Payouts 合计。Pending、Withdrawable 含下级那份。
type DistributorStats struct {
	CodesTotal    int64                                 `json:"codes_total"`
	CodesRedeemed int64                                 `json:"codes_redeemed"`
	Users         int                                   `json:"users"`
	Months        []DistributorMonth                    `json:"months"`
	Paid          float64                               `json:"paid"`
	Pending       float64                               `json:"pending"`
	Withdrawable  float64                               `json:"withdrawable"`
	Withdrawn     float64                               `json:"withdrawn"`
	Payouts       []operation_setting.DistributorPayout `json:"payouts"`
	// Children 是他名下的下级分销商，Earned、Pending 是他按 DistributorParentCommissionRate 拿的那份
	Children []DistributorChild `json:"children"`
	// Members 是他自己的人的明细；下级分销商的人不给明细
	Members []DistributorMember `json:"members"`
}

// DistributorMember 是给分销商看的一个用户：用户名给，邮箱、手机号样子的打码（店主 11-11：「可以给用户名，不给邮箱」）。
type DistributorMember struct {
	Name string `json:"name"`
	// Since 是从什么时候算他的人（兑第一张码的时间），0 是分销商本人
	Since int64 `json:"since"`
	// Paid 是累计在线充值（实付），Spent 是其中已经用掉的
	Paid  float64 `json:"paid"`
	Spent float64 `json:"spent"`
}

// roundYuan 把金额取到分。
func roundYuan(v float64) float64 {
	return math.Round(v*100) / 100
}

// maskDistributorMemberName 把像邮箱、手机号的用户名打码，别的原样给。
func maskDistributorMemberName(name string) string {
	if local, domain, ok := strings.Cut(name, "@"); ok {
		r := []rune(local)
		return string(r[:min(3, len(r)/2)]) + "***@" + domain
	}
	if len(name) >= 7 && strings.Trim(name, "0123456789") == "" {
		return name[:3] + "****" + name[len(name)-2:]
	}
	return name
}

type DistributorChild struct {
	No    int     `json:"no"`
	Users int     `json:"users"`
	Paid  float64 `json:"paid"`
	// Earned 是已用掉那部分里他的份，Pending 是没用掉那部分里他的份
	Earned  float64 `json:"earned"`
	Pending float64 `json:"pending"`
}

// GetDistributorStats 返回分销商自己的合计，再带上他每个下级分销商的人的充值和他该拿的那份，最后扣掉已打款。
func GetDistributorStats(no int, now time.Time) (*DistributorStats, error) {
	stats, earned, err := distributorStats(no, now, DistributorCommissionRate)
	if err != nil {
		return nil, err
	}
	parents, err := distributorParents()
	if err != nil {
		return nil, err
	}
	stats.Children = []DistributorChild{}
	for child, parent := range parents {
		if parent != no || child == no {
			continue
		}
		childStats, childEarned, err := distributorStats(child, now, DistributorParentCommissionRate)
		if err != nil {
			return nil, err
		}
		earned += childEarned
		stats.Pending += childStats.Pending
		stats.Children = append(stats.Children, DistributorChild{No: child, Users: childStats.Users, Paid: childStats.Paid, Earned: roundYuan(childEarned), Pending: roundYuan(childStats.Pending)})
	}
	slices.SortFunc(stats.Children, func(a, b DistributorChild) int { return a.No - b.No })

	// 打款是对公转账后手记在支付设置 distributor_payouts。余额后来又变多（签到、兑码）会让「已用掉」暂时变少，
	// 这时多打的部分先从待结算里扣，所以 待结算 + 可提现 + 已提现 总是等于 没退款的充值 × 比例
	stats.Payouts = slices.Clone(operation_setting.GetPaymentSetting().DistributorPayouts[no])
	if stats.Payouts == nil {
		stats.Payouts = []operation_setting.DistributorPayout{}
	}
	for _, p := range stats.Payouts {
		stats.Withdrawn += p.Amount
	}
	stats.Withdrawn = roundYuan(stats.Withdrawn)
	earned = roundYuan(earned)
	stats.Withdrawable = max(0, roundYuan(earned-stats.Withdrawn))
	stats.Pending = max(0, roundYuan(earned+stats.Pending-stats.Withdrawn-stats.Withdrawable))
	return stats, nil
}

// distributorParents 返回下级编号 → 上级编号。分销商本人的号兑的第一张别家的码（自己批次的不算）是哪个分销商的，
// 那个分销商就是他上级，不用手写；支付设置 distributor_parents 手写的优先，拉人不靠码的时候用。
func distributorParents() (map[int]int, error) {
	setting := operation_setting.GetPaymentSetting()
	parents := map[int]int{}
	ids := slices.Collect(maps.Keys(setting.DistributorUsers))
	if len(ids) > 0 {
		var used []Redemption
		if err := DB.Unscoped().Select("used_user_id", "name").Where("used_user_id IN ?", ids).Order("redeemed_time, id").Find(&used).Error; err != nil {
			return nil, err
		}
		decided := map[int]bool{}
		for _, r := range used {
			self := setting.DistributorUsers[r.UsedUserId]
			if decided[r.UsedUserId] || strings.HasPrefix(r.Name, DistributorBatchPrefix(self)) {
				continue
			}
			decided[r.UsedUserId] = true
			rest, ok := strings.CutPrefix(r.Name, "分销-")
			if !ok {
				continue
			}
			noText, _, ok := strings.Cut(rest, "号-")
			parent, err := strconv.Atoi(noText)
			if !ok || err != nil || parent <= 0 || parent == self {
				continue
			}
			// ponytail: 一个编号挂了几个号时，按兑码先后取第一个认出来的上级
			if _, exists := parents[self]; !exists {
				parents[self] = parent
			}
		}
	}
	maps.Copy(parents, setting.DistributorParents)
	return parents, nil
}

// distributorStats 算一个分销商名下的合计，返佣按 rate 算，口径和 中转/分销月结.sh 一样：
// 用户兑的第一张码是他的就算他的人；兑码前 24 小时以外就充过值的不算；
// 兑码前 24 小时起的成功充值都算，按北京时间分本月、上月。
// 分销商本人的号算他自己的人、充值全算；别的分销商本人的号不算他的人（店主 11-11：3 号本人归 3 号）。
// 返回的 Pending 是没用掉的充值 × rate，earned 是已用掉的充值 × rate，都没取整。
func distributorStats(no int, now time.Time, rate float64) (stats *DistributorStats, earned float64, err error) {
	prefix := DistributorBatchPrefix(no) + "%"
	stats = &DistributorStats{Members: []DistributorMember{}}
	// 作废的码不算，但作废前已经兑掉的照算（兑换码是软删除，所以要 Unscoped）
	if err := DB.Unscoped().Model(&Redemption{}).Where("name LIKE ? AND (deleted_at IS NULL OR used_user_id > 0)", prefix).Count(&stats.CodesTotal).Error; err != nil {
		return nil, 0, err
	}
	if err := DB.Unscoped().Model(&Redemption{}).Where("name LIKE ? AND used_user_id > 0", prefix).Count(&stats.CodesRedeemed).Error; err != nil {
		return nil, 0, err
	}

	type firstUse struct {
		UserId int
		T      int64
	}
	var his []firstUse
	if err := DB.Unscoped().Model(&Redemption{}).Select("used_user_id AS user_id, MIN(redeemed_time) AS t").
		Where("name LIKE ? AND used_user_id > 0", prefix).Group("used_user_id").Scan(&his).Error; err != nil {
		return nil, 0, err
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

	distributors := operation_setting.GetPaymentSetting().DistributorUsers
	mine := make([]int, 0, len(ids))
	if len(ids) > 0 {
		// ponytail: 名单整个塞进 IN，他的人上万再分批
		var first []firstUse
		if err := DB.Unscoped().Model(&Redemption{}).Select("used_user_id AS user_id, MIN(redeemed_time) AS t").
			Where("used_user_id IN ?", ids).Group("used_user_id").Scan(&first).Error; err != nil {
			return nil, 0, err
		}
		var paidFirst []firstUse
		if err := DB.Model(&TopUp{}).Select("user_id, MIN(complete_time) AS t").
			Where("user_id IN ? AND status = ?", ids, common.TopUpStatusSuccess).Group("user_id").Scan(&paidFirst).Error; err != nil {
			return nil, 0, err
		}
		firstPaid := make(map[int]int64, len(paidFirst))
		for _, p := range paidFirst {
			firstPaid[p.UserId] = p.T
		}
		for _, f := range first {
			s := since[f.UserId]
			if _, isDistributor := distributors[f.UserId]; isDistributor || f.T != s {
				continue
			}
			if t, ok := firstPaid[f.UserId]; ok && t < s-86400 {
				continue
			}
			mine = append(mine, f.UserId)
		}
	}
	for userId, n := range distributors {
		if n == no {
			mine = append(mine, userId)
			since[userId] = 0
		}
	}
	stats.Users = len(mine)
	if len(mine) == 0 {
		return stats, 0, nil
	}

	var users []User
	if err := DB.Unscoped().Select("id", "username", "quota", "used_quota").Where("id IN ?", mine).Find(&users).Error; err != nil {
		return nil, 0, err
	}
	accounts := make(map[int]User, len(users))
	for _, u := range users {
		accounts[u.Id] = u
	}

	var topUps []TopUp
	if err := DB.Select("user_id", "money", "complete_time").Where("user_id IN ? AND status = ?", mine, common.TopUpStatusSuccess).Find(&topUps).Error; err != nil {
		return nil, 0, err
	}
	paid := make(map[int]float64, len(mine))
	for _, t := range topUps {
		if t.CompleteTime < since[t.UserId]-86400 {
			continue
		}
		paid[t.UserId] += t.Money
		if t.CompleteTime < lastStart.Unix() || t.CompleteTime >= start.AddDate(0, 1, 0).Unix() {
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
		stats.Months[i].Money = roundYuan(stats.Months[i].Money)
	}

	// 先扣赠送和兑换码的、再扣充值的（店主 11-11），所以余额先当成没用掉的充值；
	// 用掉的不超过他真用掉的额度，这样后台扣掉退款的那部分余额不会算成用掉。
	// ponytail: 退款时送的部分已经用掉了的，那部分会多算成用掉；要准得按时间逐笔记账
	quotaPerYuan := common.QuotaPerUnit / operation_setting.USDExchangeRate
	for _, userId := range mine {
		account := accounts[userId] // 用户行被硬删了就是零值：余额和用量都是 0，钱照列但不返
		name := maskDistributorMemberName(account.Username)
		if account.Id == 0 {
			name = "#" + strconv.Itoa(userId)
		}
		left, spent := paid[userId], 0.0
		if quotaPerYuan > 0 {
			left = min(left, float64(max(account.Quota, 0))/quotaPerYuan)
			spent = min(paid[userId]-left, float64(account.UsedQuota)/quotaPerYuan)
		}
		stats.Paid += paid[userId]
		stats.Pending += left * rate
		earned += spent * rate
		stats.Members = append(stats.Members, DistributorMember{Name: name, Since: since[userId], Paid: roundYuan(paid[userId]), Spent: roundYuan(spent)})
	}
	stats.Paid = roundYuan(stats.Paid)
	// 充得多的在前，再按先来后到
	slices.SortFunc(stats.Members, func(a, b DistributorMember) int {
		return cmp.Or(cmp.Compare(b.Paid, a.Paid), cmp.Compare(a.Since, b.Since), cmp.Compare(a.Name, b.Name))
	})
	return stats, earned, nil
}
