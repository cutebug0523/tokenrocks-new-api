#!/usr/bin/env python3
"""本地复现 Claude Code 走 /v1/messages 时的三处问题，不打线上。

用法：python3 claude_messages_repro.py <new-api 二进制> [端口，默认 3399]

起一个假上游和一个用临时 SQLite 的 new-api，建两条渠道：
- mock-claude：Claude 渠道，假上游像 A6 一样在 usage 里带 billing_usage、cost（TR 原样透传那条路）
- mock-gpt：OpenAI 渠道，TR 自己把 chat 转成 Claude 格式（TR 自己写 billing_usage 那条路）
然后检查：
1. 不存在的模型：应回 404 + Anthropic 错误格式（旧版回 503 + OpenAI 格式，Claude Code 会重试 10 次）
2. /v1/messages/count_tokens：记录状态码（结论见提交说明：404 时 Claude Code 退回本地粗估）
3. 非流式和流式响应的 usage 里只能有 Anthropic 标准字段
只用标准库；账号、令牌都是本地临时生成的，跑完连同临时目录一起删掉。
"""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ANTHROPIC_USAGE = {'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
                   'cache_creation', 'server_tool_use', 'service_tier'}
LEAKY = {'billing_usage': {'source': 'oai_chat', 'semantic': 'openai',
                           'openai_usage': {'prompt_tokens': 12, 'completion_tokens': 2, 'total_tokens': 14, 'cost': 0.0003}}}


class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        stream = body.get('stream', False)
        if self.path.split('?')[0].endswith('/messages'):
            usage = {'input_tokens': 12, 'output_tokens': 2, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0,
                     'claude_cache_creation_5_m_tokens': 0, 'claude_cache_creation_1_h_tokens': 0, 'cost': 0.0003, **LEAKY}
            msg = {'id': 'msg_up', 'type': 'message', 'role': 'assistant', 'model': 'upstream-internal-model',
                   'content': [{'type': 'text', 'text': 'hi'}], 'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': usage}
            if not stream:
                return self.send_json(msg)
            events = [
                ('message_start', {'type': 'message_start', 'message': {**msg, 'content': [], 'stop_reason': None,
                                                                         'usage': {**usage, 'output_tokens': 1}}}),
                ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'hi'}}),
                ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': usage}),
                ('message_stop', {'type': 'message_stop'}),
            ]
            return self.send_sse(''.join(f'event: {n}\ndata: {json.dumps(d)}\n\n' for n, d in events))
        usage = {'prompt_tokens': 12, 'completion_tokens': 2, 'total_tokens': 14, 'cost': 0.0003}
        if not stream:
            return self.send_json({'id': 'c1', 'object': 'chat.completion', 'created': 1, 'model': 'upstream-internal-model',
                                   'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'hi'}, 'finish_reason': 'stop'}],
                                   'usage': usage})
        chunks = [
            {'id': 'c1', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'upstream-internal-model',
             'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'hi'}, 'finish_reason': None}]},
            {'id': 'c1', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'upstream-internal-model',
             'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
            {'id': 'c1', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'upstream-internal-model', 'choices': [], 'usage': usage},
        ]
        self.send_sse(''.join(f'data: {json.dumps(c)}\n\n' for c in chunks) + 'data: [DONE]\n\n')

    def send_json(self, obj):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_sse(self, text):
        data = text.encode()
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def call(base, path, body=None, headers=None, method='POST'):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'content-type': 'application/json', **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), e.headers


def usages(text):
    """所有 usage 对象：非流式 body 的、流式 message_start 里 message 的、message_delta 的。"""
    found = []
    payloads = [text] if text.lstrip().startswith('{') else [l[6:] for l in text.splitlines() if l.startswith('data: ')]
    for p in payloads:
        try:
            obj = json.loads(p)
        except ValueError:
            continue
        for holder in (obj, obj.get('message') or {}):
            if isinstance(holder.get('usage'), dict):
                found.append(holder['usage'])
    return found


def main():
    binary = os.path.abspath(sys.argv[1])
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 3399
    work = tempfile.mkdtemp(prefix='tr-repro-')
    upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    up = f'http://127.0.0.1:{upstream.server_address[1]}'
    env = {**os.environ, 'PORT': str(port), 'SQLITE_PATH': os.path.join(work, 'repro.db'), 'SESSION_SECRET': 'local-repro-only'}
    server = subprocess.Popen([binary, '--log-dir', work], cwd=work, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f'http://127.0.0.1:{port}'
    results = []
    try:
        for _ in range(120):
            try:
                if call(base, '/api/status', method='GET')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(0.5)
        password = os.urandom(9).hex()
        call(base, '/api/setup', {'username': 'root', 'password': password, 'confirmPassword': password,
                                  'SelfUseModeEnabled': True, 'DemoSiteEnabled': False})
        status, text, _ = call(base, '/api/user/login', {'username': 'root', 'password': password})
        admin = {'Authorization': 'Bearer ' + json.loads(text)['data']['access_token'], 'New-Api-User': '1'}
        # 本机磁盘、内存占用高时过载保护会回 503，跟这里要测的无关，关掉
        call(base, '/api/option/', {'key': 'performance_setting.monitor_enabled', 'value': 'false'}, admin, 'PUT')
        for name, ctype, models in (('mock-claude', 14, 'mock-claude'), ('mock-gpt', 1, 'mock-gpt')):
            status, text, _ = call(base, '/api/channel/', {'mode': 'single', 'channel': {
                'name': name, 'type': ctype, 'key': 'upstream-key', 'base_url': up, 'models': models, 'group': 'default'}}, admin)
            assert json.loads(text).get('success'), text
        call(base, '/api/token/', {'name': 'repro', 'unlimited_quota': True, 'expired_time': -1, 'remain_quota': 0}, admin)
        token_id = json.loads(call(base, '/api/token/?p=1&size=10', headers=admin, method='GET')[1])['data']['items'][0]['id']
        key = json.loads(call(base, f'/api/token/{token_id}/key', {}, admin)[1])['data']['key']
        if not key.startswith('sk-'):
            key = 'sk-' + key
        time.sleep(1)  # 渠道缓存
        auth = {'x-api-key': key, 'anthropic-version': '2023-06-01'}
        msg = {'max_tokens': 16, 'messages': [{'role': 'user', 'content': 'hello'}]}

        status, text, _ = call(base, '/v1/messages', {**msg, 'model': 'claude-haiku-not-here'}, auth)
        body = json.loads(text)
        ok = status == 404 and body.get('type') == 'error' and body['error'].get('type') == 'not_found_error'
        results.append(('1 未知模型 → 404 Anthropic 格式', ok, f'{status} {text[:160]}'))

        status, text, _ = call(base, '/v1/messages/count_tokens', {**msg, 'model': 'mock-claude'}, auth)
        results.append(('2 count_tokens（记录，404 时 Claude Code 退回本地估算）', True, f'{status} {text[:120]}'))

        for model in ('mock-claude', 'mock-gpt'):
            for stream in (False, True):
                status, text, _ = call(base, '/v1/messages', {**msg, 'model': model, 'stream': stream}, auth)
                found = usages(text)
                extra = sorted({k for u in found for k in u} - ANTHROPIC_USAGE)
                ok = status == 200 and found and not extra and 'upstream-internal-model' not in text
                results.append((f'3 {model} {"流式" if stream else "非流式"} usage 只有标准字段', ok,
                                f'{status} 多出的键={extra} usage={json.dumps(found[-1] if found else None)[:200]}'))
    finally:
        server.terminate()
        server.wait(timeout=10)
        upstream.shutdown()
        shutil.rmtree(work, ignore_errors=True)
    for name, ok, detail in results:
        print(('通过' if ok else '失败'), name, '|', detail)
    sys.exit(0 if all(ok for _, ok, _ in results) else 1)


if __name__ == '__main__':
    main()
