package model

import (
	"os"
	"sync"
	"testing"

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

// TestHelperWelcomeDatabaseMatrix：TR助手送的钱每个账号只加一次（同时来几次也一样），金额按元算，设成 0 就不送。
func TestHelperWelcomeDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver gorm.Dialector
			dbType := common.DatabaseTypeSQLite
			conns := 1
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(":memory:")
			case "mysql":
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN is not configured")
				}
				driver, dbType, conns = mysql.Open(dsn), common.DatabaseTypeMySQL, 8
			case "postgres":
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN is not configured")
				}
				driver, dbType, conns = postgres.Open(dsn), common.DatabaseTypePostgreSQL, 8
			}
			db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: "hw_test_"}})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(conns)

			previousDB, previousLogDB, previousMain, previousLog := DB, LOG_DB, common.MainDatabaseType(), common.LogDatabaseType()
			previousQuotaPerUnit, previousRate := common.QuotaPerUnit, operation_setting.USDExchangeRate
			setting := operation_setting.GetCheckinSetting()
			previousYuan := setting.HelperWelcomeYuan
			DB, LOG_DB = db, db
			common.SetDatabaseTypes(dbType, dbType)
			common.QuotaPerUnit, operation_setting.USDExchangeRate = 500000, 7
			t.Cleanup(func() {
				DB, LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.QuotaPerUnit, operation_setting.USDExchangeRate = previousQuotaPerUnit, previousRate
				setting.HelperWelcomeYuan = previousYuan
				assert.NoError(t, sqlDB.Close())
			})
			tables := []any{&User{}, &Log{}, &HelperWelcome{}}
			for _, table := range tables {
				require.False(t, db.Migrator().HasTable(table), "use an empty test database")
			}
			require.NoError(t, db.AutoMigrate(tables...))
			require.NoError(t, db.AutoMigrate(tables...))
			t.Cleanup(func() { assert.NoError(t, db.Migrator().DropTable(tables...)) })

			user := User{Username: "hw-user", Password: "unused", Status: common.UserStatusEnabled, Group: "default", Quota: 100}
			require.NoError(t, db.Create(&user).Error)

			// 没开（0 元）不送，也不占掉名额
			setting.HelperWelcomeYuan = 0
			quota, err := GrantHelperWelcome(user.Id)
			require.NoError(t, err)
			assert.Zero(t, quota)

			setting.HelperWelcomeYuan = 5
			var wg sync.WaitGroup
			got := make([]int, 6)
			for i := range got {
				wg.Go(func() {
					q, err := GrantHelperWelcome(user.Id)
					assert.NoError(t, err)
					got[i] = q
				})
			}
			wg.Wait()
			granted := 0
			for _, q := range got {
				if q > 0 {
					granted++
					assert.Equal(t, 357143, q) // ¥5 ÷ 7 × 500000，四舍五入
				}
			}
			assert.Equal(t, 1, granted)

			var after User
			require.NoError(t, db.First(&after, user.Id).Error)
			assert.Equal(t, 100+357143, after.Quota)
			var logs int64
			require.NoError(t, db.Model(&Log{}).Where("user_id = ? AND type = ?", user.Id, LogTypeSystem).Count(&logs).Error)
			assert.EqualValues(t, 1, logs)

			quota, err = GrantHelperWelcome(user.Id)
			require.NoError(t, err)
			assert.Zero(t, quota)
		})
	}
}
