package controller

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
)

// TokenRocks 改动：分销商后台（/distributor）。只有支付设置里 distributor_users 名单上的人能用，
// 只能在线买兑换码、看自己的合计，不带首充、档位赠送和邀请返佣。

const (
	distributorMinCodes = 10
	distributorMaxCodes = 500
)

type DistributorOrderRequest struct {
	FaceValue     int    `json:"face_value"`
	Count         int    `json:"count"`
	PaymentMethod string `json:"payment_method"`
}

func GetDistributorSelf(c *gin.Context) {
	id := c.GetInt("id")
	no, ok := operation_setting.GetPaymentSetting().DistributorUsers[id]
	if !ok {
		common.ApiSuccess(c, gin.H{"enabled": false})
		return
	}
	stats, err := model.GetDistributorStats(no, time.Now())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	orders, err := model.GetDistributorOrders(id, time.Now().Unix())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	withdrawals, err := model.GetDistributorWithdrawals(no, 20)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	// 收款信息按他上次填的带出来，不用每次重填
	withdrawAccount := ""
	if len(withdrawals) > 0 {
		withdrawAccount = withdrawals[0].Account
	}
	payMethods := []map[string]string{}
	if isEpayTopUpEnabled() {
		payMethods = operation_setting.PayMethods
	}
	common.ApiSuccess(c, gin.H{
		"enabled":                true,
		"no":                     no,
		"face_values":            operation_setting.GetPaymentSetting().DistributorFaceValues,
		"min_count":              distributorMinCodes,
		"max_count":              distributorMaxCodes,
		"commission_rate":        model.DistributorCommissionRate,
		"parent_commission_rate": model.DistributorParentCommissionRate,
		"pay_methods":            payMethods,
		"stats":                  stats,
		"orders":                 orders,
		"withdraw_min":           operation_setting.GetPaymentSetting().DistributorWithdrawMin,
		"withdrawals":            withdrawals,
		"withdraw_account":       withdrawAccount,
	})
}

type distributorWithdrawRequest struct {
	Account string `json:"account"`
}

// RequestDistributorWithdraw 分销商申请提现：把当时的可提现全提，满支付设置 distributor_withdraw_min 才行，
// 同时只能有一笔在处理。店主对公打完款在后台点「已打款」（ResolveDistributorWithdrawal）。
func RequestDistributorWithdraw(c *gin.Context) {
	var req distributorWithdrawRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	id := c.GetInt("id")
	setting := operation_setting.GetPaymentSetting()
	no, ok := setting.DistributorUsers[id]
	if !ok {
		common.ApiErrorT(c, "This page is only for distributors")
		return
	}
	account := strings.TrimSpace(req.Account)
	if account == "" || utf8.RuneCountInString(account) > 200 {
		common.ApiErrorT(c, "Enter where we should pay you, within 200 characters")
		return
	}
	w, err := model.RequestDistributorWithdrawal(id, no, account, setting.DistributorWithdrawMin, time.Now())
	switch {
	case errors.Is(err, model.ErrDistributorWithdrawInProgress):
		common.ApiErrorT(c, "You already have a withdrawal in progress")
	case errors.Is(err, model.ErrDistributorWithdrawTooSmall):
		common.ApiErrorT(c, "You can withdraw once at least {{min}} is withdrawable", map[string]any{"min": setting.DistributorWithdrawMin})
	case err != nil:
		common.ApiError(c, err)
	default:
		common.ApiSuccess(c, w)
	}
}

// GetDistributorWithdrawals 给后台：待打款的提现申请在前，再带最近处理过的 100 笔。
func GetDistributorWithdrawals(c *gin.Context) {
	list, err := model.GetAllDistributorWithdrawals(100)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, list)
}

type distributorWithdrawResolveRequest struct {
	// Action 是 paid（对公打完款了）或 reject（驳回，钱退回他的可提现）
	Action string `json:"action"`
	Note   string `json:"note"`
}

// ResolveDistributorWithdrawal 后台处理一笔提现申请，记审计日志。
func ResolveDistributorWithdrawal(c *gin.Context) {
	var req distributorWithdrawResolveRequest
	id, _ := strconv.Atoi(c.Param("id"))
	if err := common.DecodeJson(c.Request.Body, &req); err != nil || id <= 0 || (req.Action != "paid" && req.Action != "reject") {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	note := strings.TrimSpace(req.Note)
	if utf8.RuneCountInString(note) > 200 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	w, err := model.ResolveDistributorWithdrawal(id, req.Action == "paid", note, time.Now().Unix())
	if errors.Is(err, model.ErrDistributorWithdrawNotPending) {
		common.ApiErrorT(c, "This withdrawal has already been handled")
		return
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, w.UserId, "user.manage", map[string]any{"action": "distributor_withdraw_" + req.Action, "id": w.Id, "no": w.DistributorNo, "amount": w.Amount})
	common.ApiSuccess(c, w)
}

// RequestDistributorOrder 下买码订单，回的格式和充值下单（RequestEpay）一样，前端照样提交表单去付款。
func RequestDistributorOrder(c *gin.Context) {
	var req DistributorOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		paymentError(c, common.NewMessage("Invalid parameters"))
		return
	}
	id := c.GetInt("id")
	setting := operation_setting.GetPaymentSetting()
	no, ok := setting.DistributorUsers[id]
	if !ok {
		paymentError(c, common.NewMessage("This page is only for distributors"))
		return
	}
	if !slices.Contains(setting.DistributorFaceValues, req.FaceValue) {
		paymentError(c, common.NewMessage("This face value is not available"))
		return
	}
	if req.Count < distributorMinCodes || req.Count > distributorMaxCodes {
		paymentError(c, common.NewMessage("Buy between {{min}} and {{max}} codes at a time", map[string]any{"min": distributorMinCodes, "max": distributorMaxCodes}))
		return
	}
	if !isEpayTopUpEnabled() || !operation_setting.ContainsPayMethod(req.PaymentMethod) {
		paymentError(c, common.NewMessage("Payment method does not exist"))
		return
	}
	client := GetEpayClient()
	// 汇率没配好就出不了码，别让人先付钱
	if client == nil || operation_setting.USDExchangeRate <= 0 {
		paymentError(c, common.NewMessage("Payment information has not been configured by administrator"))
		return
	}

	// 面额是整数元、张数有上限，乘出来不会有小数误差
	money := strconv.Itoa(req.FaceValue*req.Count) + ".00"
	tradeNo := fmt.Sprintf("%s%dNO%s%d", model.DistributorTradeNoPrefix, id, common.GetRandomString(6), time.Now().Unix())
	returnUrl, _ := url.Parse(paymentReturnPath("/distributor"))
	notifyUrl, _ := url.Parse(service.GetCallbackAddress() + "/api/user/epay/notify")
	uri, params, err := client.Purchase(&epay.PurchaseArgs{
		Type:           req.PaymentMethod,
		ServiceTradeNo: tradeNo,
		Name:           fmt.Sprintf("TokenRocks API额度兑换码%d元×%d张", req.FaceValue, req.Count),
		Money:          money,
		Device:         epay.PC,
		NotifyUrl:      notifyUrl,
		ReturnUrl:      returnUrl,
	})
	if err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Epay failed to start payment user_id=%d trade_no=%s payment_method=%s amount=%d error=%q", id, tradeNo, req.PaymentMethod, req.FaceValue*req.Count, err.Error()))
		paymentError(c, common.NewMessage("Failed to start payment"))
		return
	}
	order := &model.DistributorOrder{
		UserId:        id,
		DistributorNo: no,
		TradeNo:       tradeNo,
		FaceValue:     req.FaceValue,
		Count:         req.Count,
		Money:         float64(req.FaceValue * req.Count),
		PaymentMethod: req.PaymentMethod,
		Status:        common.TopUpStatusPending,
		CreateTime:    time.Now().Unix(),
	}
	if err := model.DB.Create(order).Error; err != nil {
		logger.LogError(c.Request.Context(), common.LogText("Epay failed to create top-up order user_id=%d trade_no=%s payment_method=%s amount=%d error=%q", id, tradeNo, req.PaymentMethod, req.FaceValue*req.Count, err.Error()))
		paymentError(c, common.NewMessage("Failed to create order"))
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": params, "url": uri})
}

func GetDistributorOrderCodes(c *gin.Context) {
	id := c.GetInt("id")
	if _, ok := operation_setting.GetPaymentSetting().DistributorUsers[id]; !ok {
		common.ApiErrorT(c, "This page is only for distributors")
		return
	}
	orderId, _ := strconv.Atoi(c.Param("id"))
	order, keys, err := model.GetDistributorOrderCodes(id, orderId)
	if err != nil {
		common.ApiErrorT(c, "Order not found")
		return
	}
	common.ApiSuccess(c, gin.H{"face_value": order.FaceValue, "batch_name": order.BatchName, "codes": keys})
}

// GetAllDistributorOrders 给记账用：since（秒）以后付款的所有买码订单。
// GetDistributorStatsByAdmin 给后台看某个分销商的账，和他自己在 /distributor 看到的一样，结算打款前核对用。
func GetDistributorStatsByAdmin(c *gin.Context) {
	no, err := strconv.Atoi(c.Query("no"))
	if err != nil || no <= 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	stats, err := model.GetDistributorStats(no, time.Now())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, stats)
}

// GetDistributorUsers 给后台用户列表标出谁是分销商：用户 ID → 编号。
func GetDistributorUsers(c *gin.Context) {
	common.ApiSuccess(c, operation_setting.GetPaymentSetting().DistributorUsers)
}

type distributorUserRequest struct {
	UserId  int  `json:"user_id"`
	Enabled bool `json:"enabled"`
}

// SetDistributorUser 管理员在用户列表里把人设成分销商（自动编号）或移出名单；上级照旧按码自动认。
func SetDistributorUser(c *gin.Context) {
	var req distributorUserRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil || req.UserId <= 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	user, err := model.GetUserById(req.UserId, false)
	if err != nil {
		common.ApiErrorT(c, "User does not exist")
		return
	}
	if !canManageTargetRole(c.GetInt("role"), user.Role) {
		common.ApiErrorT(c, "No permission to update users of same or higher permission level")
		return
	}
	no, err := model.SetDistributor(user.Id, req.Enabled)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	action := "unset_distributor"
	if req.Enabled {
		action = "set_distributor"
	}
	recordManageAuditFor(c, user.Id, "user.manage", map[string]any{"action": action, "username": user.Username, "id": user.Id, "no": no})
	common.ApiSuccess(c, gin.H{"no": no})
}

func GetAllDistributorOrders(c *gin.Context) {
	since, _ := strconv.ParseInt(c.Query("since"), 10, 64)
	orders, err := model.GetPaidDistributorOrders(since)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, orders)
}
