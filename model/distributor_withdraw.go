package model

import (
	"errors"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// TokenRocks 改动：分销商在后台自己申请提现（店主 11-24：满门槛随时能提，不等月初）。
// 申请时把当时的可提现全提出来记一笔待打款；店主对公打完款在后台点「已打款」，这笔就算进已提现；
// 驳回的退回可提现。支付设置 distributor_payouts 里手记的老打款照样算。

const (
	DistributorWithdrawPending  = "pending"
	DistributorWithdrawPaid     = "paid"
	DistributorWithdrawRejected = "rejected"
)

var (
	ErrDistributorWithdrawInProgress = errors.New("distributor withdrawal already in progress")
	ErrDistributorWithdrawTooSmall   = errors.New("distributor withdrawable below minimum")
	ErrDistributorWithdrawNotPending = errors.New("distributor withdrawal is not pending")
)

type DistributorWithdrawal struct {
	Id            int     `json:"id"`
	DistributorNo int     `json:"distributor_no" gorm:"index"`
	UserId        int     `json:"user_id"`
	Amount        float64 `json:"amount"`
	// Account 是分销商填的收款信息（姓名 + 支付宝或银行卡），只给他本人和管理员看
	Account    string `json:"account" gorm:"type:varchar(255)"`
	Status     string `json:"status" gorm:"type:varchar(16);index"`
	Note       string `json:"note" gorm:"type:varchar(255)"`
	CreateTime int64  `json:"create_time"`
	DoneTime   int64  `json:"done_time"`
}

// RequestDistributorWithdrawal 把编号 no 当时的可提现全提出来，记一笔待打款。同一编号同时只能有一笔在处理，
// 可提现不到 minimum 元不让提。
func RequestDistributorWithdrawal(userId int, no int, account string, minimum float64, now time.Time) (*DistributorWithdrawal, error) {
	// 先在事务外算账：算账读的是全局 DB，放进事务里单连接的库会自己等自己
	stats, err := GetDistributorStats(no, now)
	if err != nil {
		return nil, err
	}
	if stats.Requested > 0 {
		return nil, ErrDistributorWithdrawInProgress
	}
	if stats.Withdrawable <= 0 || stats.Withdrawable < minimum {
		return nil, ErrDistributorWithdrawTooSmall
	}
	w := &DistributorWithdrawal{
		DistributorNo: no,
		UserId:        userId,
		Amount:        stats.Withdrawable,
		Account:       account,
		Status:        DistributorWithdrawPending,
		CreateTime:    now.Unix(),
	}
	err = DB.Transaction(func(tx *gorm.DB) error {
		// 锁住申请人的用户行：同一个人在两台上同时点，后到的等先到的提交完，再看到已经有一笔
		// ponytail: 一个编号挂了几个号、几个号同时点会各提一笔；真有这种编号再改成按编号锁
		if err := lockForUpdate(tx).Select("id").Where("id = ?", userId).First(&User{}).Error; err != nil {
			return err
		}
		var n int64
		if err := tx.Model(&DistributorWithdrawal{}).Where("distributor_no = ? AND status = ?", no, DistributorWithdrawPending).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return ErrDistributorWithdrawInProgress
		}
		return tx.Create(w).Error
	})
	if err != nil {
		return nil, err
	}
	common.SysLog(common.LogText("Distributor withdrawal requested id=%d no=%d user_id=%d amount=%.2f", w.Id, no, userId, w.Amount))
	return w, nil
}

// GetDistributorWithdrawals 返回编号 no 最近的提现申请，新的在前。
func GetDistributorWithdrawals(no int, limit int) ([]DistributorWithdrawal, error) {
	list := []DistributorWithdrawal{}
	err := DB.Where("distributor_no = ?", no).Order("id desc").Limit(limit).Find(&list).Error
	return list, err
}

// GetAllDistributorWithdrawals 给后台：所有待打款的，加上最近处理过的 limit 笔，待打款的在前。
func GetAllDistributorWithdrawals(limit int) ([]DistributorWithdrawal, error) {
	list := []DistributorWithdrawal{}
	if err := DB.Where("status = ?", DistributorWithdrawPending).Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	var done []DistributorWithdrawal
	if err := DB.Where("status <> ?", DistributorWithdrawPending).Order("id desc").Limit(limit).Find(&done).Error; err != nil {
		return nil, err
	}
	return append(list, done...), nil
}

// ResolveDistributorWithdrawal 后台处理一笔待打款：paid=true 记成已打款（算进已提现），false 驳回（退回可提现）。
func ResolveDistributorWithdrawal(id int, paid bool, note string, now int64) (*DistributorWithdrawal, error) {
	w := &DistributorWithdrawal{}
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ?", id).First(w).Error; err != nil {
			return err
		}
		if w.Status != DistributorWithdrawPending {
			return ErrDistributorWithdrawNotPending
		}
		w.Status = DistributorWithdrawRejected
		if paid {
			w.Status = DistributorWithdrawPaid
		}
		w.Note = note
		w.DoneTime = now
		return tx.Save(w).Error
	})
	if err != nil {
		return nil, err
	}
	common.SysLog(common.LogText("Distributor withdrawal %s id=%d no=%d amount=%.2f", w.Status, w.Id, w.DistributorNo, w.Amount))
	return w, nil
}
