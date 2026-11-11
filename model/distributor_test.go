package model

import (
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

// TestDistributorDatabaseMatrix 覆盖分销买码在三种库上的两条约定：
// 付款回调重复到达也只出一批码、不加余额；合计口径和 中转/分销月结.sh 的自测数据一致。
func TestDistributorDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver gorm.Dialector
			dbType := common.DatabaseTypeSQLite
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(":memory:")
			case "mysql":
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN is not configured")
				}
				driver = mysql.Open(dsn)
				dbType = common.DatabaseTypeMySQL
			case "postgres":
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN is not configured")
				}
				driver = postgres.Open(dsn)
				dbType = common.DatabaseTypePostgreSQL
			}
			db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: "fx_test_"}})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			versionSQL := "SELECT version()"
			if dialect == "sqlite" {
				versionSQL = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, db.Raw(versionSQL).Scan(&version).Error)
			t.Logf("database version: %s", version)

			previousDB, previousMain, previousLog := DB, common.MainDatabaseType(), common.LogDatabaseType()
			previousQuotaPerUnit, previousRate := common.QuotaPerUnit, operation_setting.USDExchangeRate
			previousDisplay := operation_setting.GetGeneralSetting().QuotaDisplayType
			DB = db
			common.SetDatabaseTypes(dbType, dbType)
			common.QuotaPerUnit = 500000
			operation_setting.USDExchangeRate = 7
			operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeCNY
			t.Cleanup(func() {
				DB = previousDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.QuotaPerUnit, operation_setting.USDExchangeRate = previousQuotaPerUnit, previousRate
				operation_setting.GetGeneralSetting().QuotaDisplayType = previousDisplay
				assert.NoError(t, sqlDB.Close())
			})
			tables := []any{&User{}, &Redemption{}, &TopUp{}, &DistributorOrder{}}
			for _, table := range tables {
				require.False(t, db.Migrator().HasTable(table), "use an empty test database")
			}
			// 跑两遍迁移，第二遍不该报错也不该改表
			require.NoError(t, db.AutoMigrate(tables...))
			require.NoError(t, db.AutoMigrate(tables...))
			t.Cleanup(func() { assert.NoError(t, db.Migrator().DropTable(tables...)) })

			t.Run("fulfill", func(t *testing.T) {
				distributor := User{Username: "fx-distributor", Password: "unused", Status: common.UserStatusEnabled, Group: "default", Quota: 0}
				require.NoError(t, db.Create(&distributor).Error)
				order := DistributorOrder{UserId: distributor.Id, DistributorNo: 9, TradeNo: "FX1NOtest1", FaceValue: 2, Count: 10, Money: 20, PaymentMethod: "alipay", Status: common.TopUpStatusPending, CreateTime: 1}
				require.NoError(t, db.Create(&order).Error)

				// 实付金额对不上的回调不出码，订单还是待付款
				_, err := FulfillDistributorOrder(order.TradeNo, "wxpay", "2.00")
				require.ErrorIs(t, err, ErrDistributorMoneyMismatch)
				var codeCount int64
				require.NoError(t, db.Model(&Redemption{}).Where("user_id = ?", distributor.Id).Count(&codeCount).Error)
				assert.Zero(t, codeCount)

				// 额度显示改成美元也按元给额度
				operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
				alreadyDone, err := FulfillDistributorOrder(order.TradeNo, "wxpay", "20.00")
				require.NoError(t, err)
				assert.False(t, alreadyDone)
				alreadyDone, err = FulfillDistributorOrder(order.TradeNo, "wxpay", "20.00")
				require.NoError(t, err)
				assert.True(t, alreadyDone)

				paid, keys, err := GetDistributorOrderCodes(distributor.Id, order.Id)
				require.NoError(t, err)
				assert.Equal(t, common.TopUpStatusSuccess, paid.Status)
				assert.Equal(t, "wxpay", paid.PaymentMethod)
				assert.Regexp(t, `^分销-9号-\d{4}-`+strconv.Itoa(order.Id)+`$`, paid.BatchName)
				assert.Len(t, keys, 10)
				var quotas []int
				require.NoError(t, db.Model(&Redemption{}).Where("name = ?", paid.BatchName).Pluck("quota", &quotas).Error)
				for _, q := range quotas {
					assert.Equal(t, 142857, q) // ¥2 ÷ 7 × 500000
				}
				// 后台手建的同名批次不会跟着被下载
				require.NoError(t, db.Create(&Redemption{Name: paid.BatchName, UserId: distributor.Id + 100, Key: "fxadminsame"}).Error)
				_, keys, err = GetDistributorOrderCodes(distributor.Id, order.Id)
				require.NoError(t, err)
				assert.Len(t, keys, 10)
				assert.NotContains(t, keys, "fxadminsame")

				// 订单列表：已付款的全给，没付的只给一天内的；后台补单（不带实付金额）照样出码
				now := common.GetTimestamp()
				stale := DistributorOrder{UserId: distributor.Id, DistributorNo: 9, TradeNo: "FX1NOstale", FaceValue: 1, Count: 10, Money: 10, Status: common.TopUpStatusPending, CreateTime: now - 2*86400}
				fresh := DistributorOrder{UserId: distributor.Id, DistributorNo: 9, TradeNo: "FX1NOfresh", FaceValue: 1, Count: 10, Money: 10, Status: common.TopUpStatusPending, CreateTime: now}
				require.NoError(t, db.Create(&stale).Error)
				require.NoError(t, db.Create(&fresh).Error)
				orders, err := GetDistributorOrders(distributor.Id, now)
				require.NoError(t, err)
				var ids []int
				for _, o := range orders {
					ids = append(ids, o.Id)
				}
				assert.Equal(t, []int{fresh.Id, order.Id}, ids)
				alreadyDone, err = FulfillDistributorOrder(fresh.TradeNo, "", "")
				require.NoError(t, err)
				assert.False(t, alreadyDone)
				_, keys, err = GetDistributorOrderCodes(distributor.Id, fresh.Id)
				require.NoError(t, err)
				assert.Len(t, keys, 10)
				var reloaded User
				require.NoError(t, db.First(&reloaded, distributor.Id).Error)
				assert.Zero(t, reloaded.Quota, "买码不加余额")

				_, _, err = GetDistributorOrderCodes(distributor.Id+1, order.Id)
				assert.ErrorIs(t, err, ErrTopUpNotFound, "别人的订单拿不到码")
				_, err = FulfillDistributorOrder("FX1NOmissing", "alipay", "1.00")
				assert.ErrorIs(t, err, ErrTopUpNotFound)
			})

			t.Run("stats", func(t *testing.T) {
				ts := func(s string) int64 {
					v, err := time.ParseInLocation("2006-01-02 15:04", s, distributorZone)
					require.NoError(t, err)
					return v.Unix()
				}
				// 和 中转/分销月结-自测.sh 同一份数据：A 新人、B 第一张码是别家的、C 一个月前充过、D 被邀请、E 先充一小时再兑
				const a, b, c, d, e = 101, 102, 103, 104, 105
				codes := []Redemption{
					{Name: "分销-7号-1106", UsedUserId: a, RedeemedTime: ts("2026-11-02 10:00")},
					{Name: "闲鱼1元体验卡", UsedUserId: b, RedeemedTime: ts("2026-10-20 10:00")},
					{Name: "分销-7号-1106", UsedUserId: b, RedeemedTime: ts("2026-11-03 10:00")},
					{Name: "分销-7号-1106", UsedUserId: c, RedeemedTime: ts("2026-11-03 10:00")},
					{Name: "分销-7号-1120", UsedUserId: d, RedeemedTime: ts("2026-11-04 10:00")},
					{Name: "分销-7号-1106", UsedUserId: e, RedeemedTime: ts("2026-11-07 10:00")},
					{Name: "分销-7号-1106"},
					{Name: "分销-7号-1101"},
					{Name: "分销-7号-1101", UsedUserId: a, RedeemedTime: ts("2026-11-02 11:00")},
					{Name: "分销-77号-1106", UsedUserId: 106, RedeemedTime: ts("2026-11-02 10:00")},
				}
				for i := range codes {
					codes[i].Key = "fxstats" + strconv.Itoa(i)
				}
				require.NoError(t, db.Create(&codes).Error)
				require.NoError(t, db.Delete(&codes[7]).Error)
				require.NoError(t, db.Delete(&codes[8]).Error)
				topUps := []TopUp{
					{UserId: a, TradeNo: "a1", Money: 100, CompleteTime: ts("2026-11-05 10:00"), Status: common.TopUpStatusSuccess},
					{UserId: a, TradeNo: "a2", Money: 50, CompleteTime: ts("2026-11-30 23:59"), Status: common.TopUpStatusSuccess},
					{UserId: a, TradeNo: "a3", Money: 30, CompleteTime: ts("2026-11-06 10:00"), Status: "failed"},
					{UserId: a, TradeNo: "a4", Money: 40, CompleteTime: ts("2026-12-01 00:00"), Status: common.TopUpStatusSuccess},
					{UserId: b, TradeNo: "b1", Money: 100, CompleteTime: ts("2026-11-05 10:00"), Status: common.TopUpStatusSuccess},
					{UserId: c, TradeNo: "c0", Money: 10, CompleteTime: ts("2026-10-01 10:00"), Status: common.TopUpStatusSuccess},
					{UserId: c, TradeNo: "c1", Money: 100, CompleteTime: ts("2026-11-05 10:00"), Status: common.TopUpStatusSuccess},
					{UserId: d, TradeNo: "d1", Money: 20, CompleteTime: ts("2026-11-06 10:00"), Status: common.TopUpStatusSuccess},
					{UserId: e, TradeNo: "e1", Money: 30, CompleteTime: ts("2026-11-07 09:00"), Status: common.TopUpStatusSuccess},
					{UserId: e, TradeNo: "e2", Money: 10, CompleteTime: ts("2026-11-08 10:00"), Status: common.TopUpStatusSuccess},
					{UserId: 106, TradeNo: "f1", Money: 40, CompleteTime: ts("2026-11-09 10:00"), Status: common.TopUpStatusSuccess},
					{UserId: 201, TradeNo: "g1", Money: 20, CompleteTime: ts("2026-11-09 10:00"), Status: common.TopUpStatusSuccess},
					{UserId: 202, TradeNo: "h1", Money: 60, CompleteTime: ts("2026-11-09 10:00"), Status: common.TopUpStatusSuccess},
				}
				require.NoError(t, db.Create(&topUps).Error)
				// 201 是 7 号本人的号，没兑过码；202 是 78 号本人的号，先兑自己批次的码、再兑 7 号的码，所以 78 号自动认 7 号当上级。
				// 77 号是手写的 7 号下级；自己当自己上级的写法不算
				require.NoError(t, db.Create(&[]Redemption{
					{Name: "分销-78号-本人", UsedUserId: 202, RedeemedTime: ts("2026-11-01 10:00"), Key: "fxself78"},
					{Name: "分销-7号-1106", UsedUserId: 202, RedeemedTime: ts("2026-11-03 09:00"), Key: "fxchild78"},
				}).Error)
				for _, u := range []User{
					{Id: a, Username: "alice"}, {Id: d, Username: "13812345678"}, {Id: e, Username: "eve@qq.com"}, {Id: 201, Username: "boss7"},
				} {
					u.Password, u.Status, u.Group, u.AffCode = "unused", common.UserStatusEnabled, "default", "fxaff"+strconv.Itoa(u.Id)
					require.NoError(t, db.Create(&u).Error)
				}
				payment := operation_setting.GetPaymentSetting()
				previousUsers, previousParents := payment.DistributorUsers, payment.DistributorParents
				payment.DistributorUsers = map[int]int{201: 7, 202: 78}
				payment.DistributorParents = map[int]int{77: 7, 7: 7}
				t.Cleanup(func() { payment.DistributorUsers, payment.DistributorParents = previousUsers, previousParents })

				stats, err := GetDistributorStats(7, time.Unix(ts("2026-11-15 12:00"), 0))
				require.NoError(t, err)
				assert.Equal(t, &DistributorStats{
					CodesTotal:    8, // 7 张有效 + 1 张兑过后作废的；作废没兑的不算；77、78 号的不算
					CodesRedeemed: 7,
					Users:         4, // A、D、E 和 7 号本人；78 号本人兑过 7 号的码也不算 7 号的人
					Months: []DistributorMonth{
						{Month: "2026-11", Count: 6, Money: 230, Commission: 23},
						{Month: "2026-10", Count: 0, Money: 0, Commission: 0},
					},
					// 本月充得多的在前；手机号、邮箱打码；本人 Since 是 0
					Members: []DistributorMember{
						{Name: "alice", Since: ts("2026-11-02 10:00"), ThisMonth: 150},
						{Name: "e***@qq.com", Since: ts("2026-11-07 10:00"), ThisMonth: 40},
						{Name: "boss7", Since: 0, ThisMonth: 20},
						{Name: "138****78", Since: ts("2026-11-04 10:00"), ThisMonth: 20},
					},
					Children: []DistributorChild{
						{No: 77, Users: 1, Months: []DistributorMonth{
							{Month: "2026-11", Count: 1, Money: 40, Commission: 2},
							{Month: "2026-10", Count: 0, Money: 0, Commission: 0},
						}},
						{No: 78, Users: 1, Months: []DistributorMonth{
							{Month: "2026-11", Count: 1, Money: 60, Commission: 3},
							{Month: "2026-10", Count: 0, Money: 0, Commission: 0},
						}},
					},
				}, stats)

				// 下级自己看：自己的人照拿 10%，没有下级
				stats, err = GetDistributorStats(77, time.Unix(ts("2026-11-15 12:00"), 0))
				require.NoError(t, err)
				assert.Equal(t, 1, stats.Users)
				assert.Equal(t, 4.0, stats.Months[0].Commission)
				assert.Empty(t, stats.Children)

				// 12 月看：本月是 A 的 a4，上月是 11 月那 6 笔
				stats, err = GetDistributorStats(7, time.Unix(ts("2026-12-01 00:00"), 0))
				require.NoError(t, err)
				assert.Equal(t, []DistributorMonth{
					{Month: "2026-12", Count: 1, Money: 40, Commission: 4},
					{Month: "2026-11", Count: 6, Money: 230, Commission: 23},
				}, stats.Months)

				// 下级自己看：本人照拿 10%，上级的上级不拿
				stats, err = GetDistributorStats(78, time.Unix(ts("2026-11-15 12:00"), 0))
				require.NoError(t, err)
				assert.Equal(t, 1, stats.Users)
				assert.Equal(t, 6.0, stats.Months[0].Commission)
				assert.Empty(t, stats.Children)

				// 手写的上级优先于按码认的
				payment.DistributorParents = map[int]int{77: 7, 78: 77}
				stats, err = GetDistributorStats(7, time.Unix(ts("2026-11-15 12:00"), 0))
				require.NoError(t, err)
				require.Len(t, stats.Children, 1)
				assert.Equal(t, 77, stats.Children[0].No)
				stats, err = GetDistributorStats(77, time.Unix(ts("2026-11-15 12:00"), 0))
				require.NoError(t, err)
				require.Len(t, stats.Children, 1)
				assert.Equal(t, 78, stats.Children[0].No)

				stats, err = GetDistributorStats(8, time.Unix(ts("2026-11-15 12:00"), 0))
				require.NoError(t, err)
				assert.Zero(t, stats.CodesTotal)
				assert.Zero(t, stats.Users)
			})
		})
	}
}

// TestDistributorOptionValidation：名单和面额写错要当场拒绝，不然配置加载会悄悄沿用旧值。
func TestDistributorOptionValidation(t *testing.T) {
	for _, tc := range []struct {
		key   string
		value string
		ok    bool
	}{
		{"payment_setting.distributor_users", `{"535":1,"7":2}`, true},
		{"payment_setting.distributor_users", `{}`, true},
		{"payment_setting.distributor_users", `{"535":1,}`, false},
		{"payment_setting.distributor_users", ``, false},
		{"payment_setting.distributor_users", `null`, false},
		{"payment_setting.distributor_users", `{"535":"1"}`, false},
		{"payment_setting.distributor_users", `{"535":0}`, false},
		{"payment_setting.distributor_parents", `{"3":1}`, true},
		{"payment_setting.distributor_parents", `{}`, true},
		{"payment_setting.distributor_parents", `{"3":3}`, false},
		{"payment_setting.distributor_parents", `{"3":0}`, false},
		{"payment_setting.distributor_parents", `null`, false},
		{"payment_setting.distributor_face_values", `[1,2,5]`, true},
		{"payment_setting.distributor_face_values", `[]`, true},
		{"payment_setting.distributor_face_values", `[0,2]`, false},
		{"payment_setting.distributor_face_values", `[1001]`, false},
		{"payment_setting.distributor_face_values", `null`, false},
		{"payment_setting.distributor_face_values", `["2"]`, false},
	} {
		err := validateOptionValue(tc.key, tc.value)
		if tc.ok {
			assert.NoError(t, err, tc.key+" "+tc.value)
		} else {
			assert.Error(t, err, tc.key+" "+tc.value)
		}
	}
}
