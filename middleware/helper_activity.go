package middleware

import (
	"bytes"
	"cmp"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"

	"github.com/gin-gonic/gin"
)

// TokenRocks 小助手的「编程助手在干什么」：只在内存里记，不碰数据库。
// 小助手最近 10 分钟轮询过 /api/user/helper/activity 的用户才记录，其余请求只多一次 map 查找。

// HelperActivityRoute 是小助手轮询的路由（access token 规则和审计用的 "METHOD 全路径"）。
const HelperActivityRoute = "GET /api/user/helper/activity"

const (
	helperActivityTTL       = 10 * time.Minute
	helperActivitySize      = 40
	helperActivityBodyLimit = 1024
	helperActivityErrorMax  = 200
)

type HelperActivityEvent struct {
	Seq       int64  `json:"seq"`
	At        int64  `json:"at"`
	Phase     string `json:"phase"`
	RequestId string `json:"request_id"`
	Model     string `json:"model"`
	Status    int    `json:"status,omitempty"`
	Error     string `json:"error,omitempty"`
	Ms        int64  `json:"ms,omitempty"`
}

type HelperActivityPage struct {
	Seq      int64                 `json:"seq"`
	Inflight int                   `json:"inflight"`
	Items    []HelperActivityEvent `json:"items"`
}

type helperActivityFeed struct {
	polledAt time.Time
	seq      int64
	inflight int
	events   [helperActivitySize]HelperActivityEvent
}

// ponytail: 单进程单节点，一把全局锁，每个订阅用户最多 40 条；多节点要挪到 Redis，订阅用户上千再换分片锁。
var helperActivity = struct {
	sync.Mutex
	feeds   map[int]*helperActivityFeed
	sweptAt time.Time
}{feeds: map[int]*helperActivityFeed{}}

// record 调用方持有 helperActivity 锁。
func (feed *helperActivityFeed) record(event HelperActivityEvent) {
	feed.seq++
	event.Seq = feed.seq
	event.At = time.Now().UnixMilli()
	feed.events[feed.seq%helperActivitySize] = event
}

// PollHelperActivity 把用户标成已订阅，返回 seq 大于 after 的事件（旧的在前）。
// 不带 after 只订阅、不返回事件。
func PollHelperActivity(userID int, after string) HelperActivityPage {
	now := time.Now()
	helperActivity.Lock()
	defer helperActivity.Unlock()
	if now.Sub(helperActivity.sweptAt) > helperActivityTTL {
		for id, feed := range helperActivity.feeds {
			if now.Sub(feed.polledAt) > helperActivityTTL {
				delete(helperActivity.feeds, id)
			}
		}
		helperActivity.sweptAt = now
	}
	feed := helperActivity.feeds[userID]
	if feed == nil {
		// seq 从当前毫秒数起跳：重启或状态被清掉后，小助手手里的旧 after 仍小于新 seq。
		feed = &helperActivityFeed{seq: now.UnixMilli()}
		helperActivity.feeds[userID] = feed
	}
	feed.polledAt = now
	page := HelperActivityPage{Seq: feed.seq, Inflight: feed.inflight, Items: []HelperActivityEvent{}}
	from, err := strconv.ParseInt(after, 10, 64)
	if err != nil {
		return page
	}
	from = min(from, feed.seq) // after 传超大值时 +1 会溢出成负数下标
	for seq := max(from, feed.seq-helperActivitySize) + 1; seq <= feed.seq; seq++ {
		if event := feed.events[seq%helperActivitySize]; event.Seq == seq {
			page.Items = append(page.Items, event)
		}
	}
	return page
}

// HelperActivity 放在 /v1 的 TokenAuth 之后，后面中间件的限流、无可用渠道等错误也能记到。
func HelperActivity() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		requestID := c.GetString(common.RequestIdKey)
		helperActivity.Lock()
		feed := helperActivity.feeds[c.GetInt("id")]
		// WebSocket 一连就是整场会话，算进进行中会让小助手一直显示在干活。
		subscribed := feed != nil && start.Sub(feed.polledAt) <= helperActivityTTL && !c.IsWebsocket()
		if subscribed {
			feed.inflight++
			feed.record(HelperActivityEvent{Phase: "start", RequestId: requestID})
		}
		helperActivity.Unlock()
		if !subscribed {
			c.Next()
			return
		}

		writer := &auditResponseWriter{ResponseWriter: c.Writer, body: bytes.NewBuffer(nil), maxSize: helperActivityBodyLimit}
		c.Writer = writer
		// defer：处理中 panic 也要记结束，否则进行中数一直不归零。
		defer func() {
			event := HelperActivityEvent{
				Phase:     "end",
				RequestId: requestID,
				Model:     common.GetContextKeyString(c, constant.ContextKeyOriginalModel),
				Status:    writer.Status(),
				Ms:        time.Since(start).Milliseconds(),
			}
			// panic 时外层 Recovery 还没写 500，这里的状态还是默认的 200。
			recovered := recover()
			if recovered != nil {
				event.Status = http.StatusInternalServerError
			}
			if event.Status >= http.StatusBadRequest {
				event.Error = helperActivityError(writer.body.Bytes(), event.Status)
			}
			helperActivity.Lock()
			feed.inflight--
			feed.record(event)
			helperActivity.Unlock()
			if recovered != nil {
				panic(recovered)
			}
		}()
		c.Next()
	}
}

// helperActivityError 取客户端实际收到的错误正文（前 1KB）里的那句话，不碰上游原始报错。
func helperActivityError(body []byte, status int) string {
	message := strings.TrimSpace(string(body))
	var parsed struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if common.Unmarshal(body, &parsed) == nil {
		message = cmp.Or(strings.TrimSpace(parsed.Error.Message), strings.TrimSpace(parsed.Message), message)
	}
	if message == "" {
		return http.StatusText(status)
	}
	if runes := []rune(message); len(runes) > helperActivityErrorMax {
		message = string(runes[:helperActivityErrorMax])
	}
	return message
}
