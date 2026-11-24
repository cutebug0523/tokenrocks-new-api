package model

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 桌面端登录前腾位置：同一台机器的旧令牌、3 天没用的同名令牌删掉；满了再删同名里最久没用的；别的名字一个不碰。
func TestPruneSignInAccessTokens(t *testing.T) {
	truncateTables(t)
	user := User{Username: "prune-user", Password: "password", AuthVersion: 1}
	require.NoError(t, DB.Create(&user).Error)
	const helper, now, cutoff = "TokenRocks 小助手", int64(10_000_000), int64(10_000_000 - 3*86400)
	add := func(hash, name, device string, created, used int64) {
		require.NoError(t, DB.Create(&UserAccessToken{UserId: user.Id, Name: name, TokenHash: hash, DeviceId: device, CreatedAt: created, LastUsedAt: used, ExpiresAt: now + 86400}).Error)
	}
	left := func() []string {
		var hashes []string
		require.NoError(t, DB.Model(&UserAccessToken{}).Where("user_id = ?", user.Id).Order("id").Pluck("token_hash", &hashes).Error)
		return hashes
	}
	add("same-device", helper, "dev-aaaaaaaaaaaaaaaa", now-100, now-10)  // 同一台机器，还在用：换掉
	add("other-device", helper, "dev-bbbbbbbbbbbbbbbb", now-100, now-10) // 另一台机器，还在用：留着
	add("stale", helper, "", now-10*86400, now-4*86400)                  // 4 天没用：删
	add("never-used-new", helper, "", now-3600, 0)                       // 刚建还没用：留着
	add("console-old", "my script", "", now-10*86400, now-9*86400)       // 网站上建的，旧也不碰
	add("lee-old", "LEE", "", now-10*86400, now-9*86400)                 // LEE 的，名字不同不碰

	// 上线前建的行 device_id 是 NULL，读出来要当空的
	require.NoError(t, DB.Exec("UPDATE user_access_tokens SET device_id = NULL WHERE token_hash IN ('stale', 'never-used-new')").Error)

	dropped, err := PruneSignInAccessTokens(user.Id, helper, "dev-aaaaaaaaaaaaaaaa", cutoff, 20)
	require.NoError(t, err)
	assert.Len(t, dropped, 2)
	assert.Equal(t, []string{"other-device", "never-used-new", "console-old", "lee-old"}, left())

	// 满了：只从同名里删最久没用的，腾出一个位置
	for i := 0; i < 16; i++ {
		add("fresh-"+string(rune('a'+i)), helper, "", now-50, now-int64(i))
	}
	require.Len(t, left(), 20)
	dropped, err = PruneSignInAccessTokens(user.Id, helper, "", cutoff, 20)
	require.NoError(t, err)
	require.Len(t, dropped, 1)
	assert.Equal(t, "never-used-new", dropped[0].TokenHash, "没用过的按建的时间算（now-3600），比别的都久")
	assert.Len(t, left(), 19)
	assert.Contains(t, left(), "console-old")
}
