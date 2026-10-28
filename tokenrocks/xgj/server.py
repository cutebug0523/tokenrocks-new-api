#!/usr/bin/env python3
"""闲管家推送接收服务（TokenRocks 发货）。

现在是只记录模式（XGJ_MODE=observe）：验签、把推送原样记到 data/notify-日期.jsonl、按文档回 success，
不生成兑换码、不发货。发码逻辑等看清真实推送后再加。

服务器上：/opt/xgj/server.py，systemd 服务 xgj，监听 127.0.0.1:8790，nginx 把 https://tokenrocks.ai/xgj/ 转过来。
- 推送地址：订单 /xgj/notify/order，商品 /xgj/notify/product
- 密钥：$XGJ_DIR/app.json（{"app_key","app_secret"}，权限 600）
- 自检：python3 server.py --selftest
只用标准库。日志不打印密钥。
"""
import hashlib
import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DIR = os.environ.get("XGJ_DIR", "/opt/xgj")
MODE = os.environ.get("XGJ_MODE", "observe")
PORT = int(os.environ.get("XGJ_PORT", "8790"))
PATHS = {"/xgj/notify/order": "order", "/xgj/notify/product": "product"}
MAX_BODY = 64 * 1024
TS_WINDOW = 300  # 文档：时间戳 5 分钟内有效
CST = timezone(timedelta(hours=8))
_write_lock = threading.Lock()


def sign(app_key, app_secret, body: bytes, ts) -> str:
    """闲管家签名：md5("AppKey,md5(body),时间戳,AppSecret")，body 用原始字节。"""
    body_md5 = hashlib.md5(body).hexdigest()
    return hashlib.md5(f"{app_key},{body_md5},{ts},{app_secret}".encode()).hexdigest()


def load_app():
    with open(os.path.join(DIR, "app.json")) as f:
        cfg = json.load(f)
    return str(cfg["app_key"]), cfg["app_secret"]


def record(kind, entry):
    os.makedirs(os.path.join(DIR, "data"), exist_ok=True)
    path = os.path.join(DIR, "data", f"notify-{datetime.now(CST):%Y-%m-%d}.jsonl")
    with _write_lock, open(path, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


class Handler(BaseHTTPRequestHandler):
    server_version = "xgj/1"

    def _reply(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path == "/xgj/health":
            return self._reply(200, {"ok": True, "mode": MODE})
        self._reply(404, {"result": "fail", "msg": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        kind = PATHS.get(url.path)
        if not kind:
            return self._reply(404, {"result": "fail", "msg": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._reply(413, {"result": "fail", "msg": "body too large"})
        body = self.rfile.read(length)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        app_key, app_secret = self.server.app
        ts = q.get("timestamp", "")
        sign_ok = q.get("appid") == app_key and q.get("sign") == sign(app_key, app_secret, body, ts)
        ts_ok = ts.isdigit() and abs(time.time() - int(ts)) <= TS_WINDOW
        try:
            payload = json.loads(body or b"{}")
        except ValueError:
            payload = body.decode("utf-8", "replace")
        record(kind, {
            "recv_at": datetime.now(CST).isoformat(timespec="seconds"),
            "kind": kind, "mode": MODE, "sign_ok": sign_ok, "ts_ok": ts_ok,
            "ip": self.headers.get("X-Real-IP") or self.client_address[0],
            "query_timestamp": ts, "body": payload,
        })
        if not (sign_ok and ts_ok):
            return self._reply(200, {"result": "fail", "msg": "签名失败" if not sign_ok else "时间戳过期"})
        # ponytail: 只记录模式，发码逻辑（TR 生成兑换码 → 写卡种 → 无需物流发货）看清真实推送后再加
        self._reply(200, {"result": "success", "msg": "接收成功"})

    def log_message(self, fmt, *args):
        sys.stdout.write(f"{datetime.now(CST):%m-%d %H:%M:%S} {self.headers.get('X-Real-IP') or self.client_address[0]} {fmt % args}\n")
        sys.stdout.flush()


def selftest():
    # 闲管家文档「接入说明」里的签名示例
    assert sign("203413189371893", "o9wl81dncmvby3ijpq7eur456zhgtaxs",
                b'{"product_id":"219530767978565"}', 1636087298) == "c26c8a48809141f3dd80bd9b9ddb41ea"
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    httpd.app = load_app()
    print(f"xgj listening 127.0.0.1:{PORT} mode={MODE} dir={DIR}", flush=True)
    httpd.serve_forever()
