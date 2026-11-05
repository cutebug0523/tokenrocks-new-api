package middleware

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newHelperActivityTestEngine(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	helperActivity.Lock()
	helperActivity.feeds = map[int]*helperActivityFeed{}
	helperActivity.sweptAt = time.Time{}
	helperActivity.Unlock()
	engine := gin.New()
	engine.Use(RequestId())
	engine.POST("/v1/chat/completions", func(c *gin.Context) {
		id, _ := strconv.Atoi(c.GetHeader("X-Test-User"))
		c.Set("id", id)
	}, HelperActivity(), func(c *gin.Context) {
		if c.GetHeader("X-Test-Inflight") != "" {
			c.Header("X-Test-Inflight", strconv.Itoa(PollHelperActivity(7, "").Inflight))
		}
		c.Set("original_model", "glm-5.3")
		c.Status(http.StatusOK)
	})
	return engine
}

func serveHelperActivityRelay(engine *gin.Engine, userID int, header string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
	request.Header.Set("X-Test-User", strconv.Itoa(userID))
	if header != "" {
		request.Header.Set(header, "1")
	}
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	return response
}

func TestHelperActivityRecordsOnlyForRecentlyPolledUsers(t *testing.T) {
	engine := newHelperActivityTestEngine(t)

	serveHelperActivityRelay(engine, 8, "")
	helperActivity.Lock()
	assert.Empty(t, helperActivity.feeds, "a user whose helper never polled gets no state")
	helperActivity.Unlock()

	first := PollHelperActivity(7, "")
	assert.Empty(t, first.Items, "the subscribing poll returns no events")
	assert.NotNil(t, first.Items)

	response := serveHelperActivityRelay(engine, 7, "X-Test-Inflight")
	assert.Equal(t, "1", response.Header().Get("X-Test-Inflight"), "a running request counts as in flight")
	page := PollHelperActivity(7, strconv.FormatInt(first.Seq, 10))
	require.Len(t, page.Items, 2)
	assert.Equal(t, first.Seq+2, page.Seq)
	assert.Equal(t, 0, page.Inflight)
	start, end := page.Items[0], page.Items[1]
	assert.Equal(t, HelperActivityEvent{Seq: first.Seq + 1, At: start.At, Phase: "start", RequestId: response.Header().Get(common.RequestIdKey)}, start)
	assert.Equal(t, HelperActivityEvent{Seq: first.Seq + 2, At: end.At, Phase: "end", RequestId: start.RequestId, Model: "glm-5.3", Status: http.StatusOK, Ms: end.Ms}, end)
	assert.NotEmpty(t, start.RequestId)

	after := PollHelperActivity(7, strconv.FormatInt(first.Seq+1, 10))
	require.Len(t, after.Items, 1)
	assert.Equal(t, "end", after.Items[0].Phase)

	for range 30 {
		serveHelperActivityRelay(engine, 7, "")
	}
	bounded := PollHelperActivity(7, "0")
	require.Len(t, bounded.Items, helperActivitySize, "only the newest events are kept")
	assert.Equal(t, bounded.Seq, bounded.Items[helperActivitySize-1].Seq)
	assert.Equal(t, bounded.Seq-helperActivitySize+1, bounded.Items[0].Seq)

	helperActivity.Lock()
	helperActivity.feeds[7].polledAt = time.Now().Add(-helperActivityTTL - time.Minute)
	helperActivity.sweptAt = time.Now().Add(-helperActivityTTL - time.Minute)
	helperActivity.Unlock()
	serveHelperActivityRelay(engine, 7, "")
	helperActivity.Lock()
	assert.Equal(t, bounded.Seq, helperActivity.feeds[7].seq, "recording stops once the helper stops polling")
	helperActivity.Unlock()

	PollHelperActivity(9, "")
	helperActivity.Lock()
	assert.NotContains(t, helperActivity.feeds, 7, "a stale user's state is dropped")
	assert.Contains(t, helperActivity.feeds, 9)
	helperActivity.Unlock()
}

func TestHelperActivityErrorIsWhatTheClientReceived(t *testing.T) {
	long := strings.Repeat("限", 300)
	cases := []struct {
		body string
		want string
	}{
		{`{"error":{"message":"当前分组 default 下对于模型 x 无可用渠道","type":"new_api_error"}}`, "当前分组 default 下对于模型 x 无可用渠道"},
		{`{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`, "slow down"},
		{`{"success":false,"message":"quota exhausted"}`, "quota exhausted"},
		{"  upstream gateway timeout \n", "upstream gateway timeout"},
		{"", "Too Many Requests"},
		{`{"error":{"message":"` + long + `"}}`, strings.Repeat("限", helperActivityErrorMax)},
	}
	for _, tc := range cases {
		assert.Equal(t, tc.want, helperActivityError([]byte(tc.body), http.StatusTooManyRequests), tc.body)
	}
}

type helperDeadlineRecorder struct {
	*httptest.ResponseRecorder
	deadline time.Time
}

func (r *helperDeadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	r.deadline = deadline
	return nil
}

// 订阅用户的流式请求：写超时要能穿过 HelperActivity 套的那层；panic 记成 500；超大 after 不越界。
func TestHelperActivityKeepsStreamingAndEdgeCases(t *testing.T) {
	newHelperActivityTestEngine(t)
	PollHelperActivity(7, "")
	engine := gin.New()
	engine.Use(func(c *gin.Context) {
		defer func() { _ = recover() }()
		c.Set("id", 7)
		c.Next()
	}, HelperActivity())
	engine.POST("/stream", func(c *gin.Context) {
		require.NoError(t, http.NewResponseController(c.Writer).SetWriteDeadline(time.Unix(1, 0)))
		c.Status(http.StatusOK)
	})
	engine.POST("/panic", func(c *gin.Context) { panic("boom") })

	recorder := &helperDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/stream", nil))
	assert.Equal(t, time.Unix(1, 0), recorder.deadline)
	engine.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/panic", nil))

	page := PollHelperActivity(7, "0")
	require.Len(t, page.Items, 4)
	assert.Equal(t, http.StatusInternalServerError, page.Items[3].Status)
	assert.Equal(t, 0, page.Inflight)
	assert.Empty(t, PollHelperActivity(7, "9223372036854775807").Items)
}
