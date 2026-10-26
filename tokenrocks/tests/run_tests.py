#!/usr/bin/env python3
"""TokenRocks 模型实测：每周跑一次，结果写进静态站，供模型详情页的「实测」标签读取。

服务器上的用法（cron 每周一 04:00）：
    python3 /opt/tokenrocks-tests/run_tests.py [模型名 ...]

- 测哪些模型：MODELS（或命令行参数）。线路和分组每次从 /api/pricing 读，跟着后台配置走。
- 密钥：/opt/tokenrocks-tests/keys.json，{"分组名": "sk-..."}，每个分组一把专用测试密钥，权限 600。
- 输出：/var/www/tokenrocks-site/_s/tests/models/<模型>.json 和 art/<模型>-<线路>.svg|html。
- 只用标准库。日志不打印密钥。
"""
import json
import os
import random
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = 'https://tokenrocks.ai'
OUT = '/var/www/tokenrocks-site/_s/tests'
KEYS_FILE = '/opt/tokenrocks-tests/keys.json'
PROMPT = 'Generate an SVG of a pelican riding a bicycle'
MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6-astra', 'deepseek-v4.1-flash', 'qwen3.8-max']
TIERS = {'value': '特价', 'enterprise': '满血'}
MAX_ART_BYTES = 300 * 1024
HKT = timezone(timedelta(hours=8))


def log(*args):
    print(datetime.now(HKT).strftime('%H:%M:%S'), *args, flush=True)


def ms_since(t0):
    return int((time.time() - t0) * 1000)


def http_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'user-agent': 'tokenrocks-tests/1'}), timeout=60) as r:
        return json.loads(r.read())


def post(path, key, fmt, body, timeout, stream=False):
    headers = {'content-type': 'application/json', 'user-agent': 'tokenrocks-tests/1'}
    if fmt == 'anthropic':
        headers['x-api-key'] = key
        headers['anthropic-version'] = '2023-06-01'
    else:
        headers['authorization'] = 'Bearer ' + key
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers=headers, method='POST')
    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        return {'status': e.code, 'ms': ms_since(t0), 'error': e.read()[:500].decode('utf-8', 'replace')}
    except Exception as e:  # 超时、断连
        return {'status': 0, 'ms': ms_since(t0), 'error': str(e)[:300]}
    with resp:
        if not stream:
            try:
                return {'status': resp.status, 'ms': ms_since(t0), 'json': json.loads(resp.read())}
            except Exception as e:
                return {'status': 0, 'ms': ms_since(t0), 'error': 'bad json: ' + str(e)[:200]}
        text, stop, usage, first = '', None, {}, None
        try:
            for raw in resp:
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('data:'):
                    continue
                data = line[5:].strip()
                if data == '[DONE]':
                    continue
                try:
                    ev = json.loads(data)
                except ValueError:
                    continue
                if fmt == 'anthropic':
                    kind = ev.get('type')
                    if kind == 'message_start':
                        usage.update((ev.get('message') or {}).get('usage') or {})
                    elif kind == 'content_block_delta' and (ev.get('delta') or {}).get('type') == 'text_delta':
                        first = first or ms_since(t0)
                        text += ev['delta'].get('text', '')
                    elif kind == 'message_delta':
                        stop = (ev.get('delta') or {}).get('stop_reason') or stop
                        usage.update(ev.get('usage') or {})
                else:
                    choice = (ev.get('choices') or [{}])[0]
                    content = (choice.get('delta') or {}).get('content')
                    if content:
                        first = first or ms_since(t0)
                        text += content
                    if choice.get('finish_reason'):
                        stop = choice['finish_reason']
                    if ev.get('usage'):
                        usage.update(ev['usage'])
        except Exception as e:
            return {'status': 0, 'ms': ms_since(t0), 'error': 'stream broken: ' + str(e)[:200], 'text': text}
        return {'status': resp.status, 'ms': ms_since(t0), 'first_text_ms': first, 'stop': stop, 'usage': usage, 'text': text}


def body_for(model, fmt, vendor, prompt, max_tokens, stream, effort=None):
    body = {'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'stream': stream}
    if fmt == 'anthropic' or vendor != 'OpenAI':
        body['max_tokens'] = max_tokens
    else:
        body['max_completion_tokens'] = max_tokens
    if stream and fmt == 'openai':
        body['stream_options'] = {'include_usage': True}
    if effort and fmt == 'anthropic':
        body['output_config'] = {'effort': effort}
    return body


def reply_text(fmt, data):
    if fmt == 'anthropic':
        return ''.join(b.get('text', '') for b in data.get('content') or [] if b.get('type') == 'text')
    choices = data.get('choices') or [{}]
    return (choices[0].get('message') or {}).get('content') or ''


def input_tokens_of(usage):
    return usage.get('input_tokens', usage.get('prompt_tokens'))


def output_tokens_of(usage):
    return usage.get('output_tokens', usage.get('completion_tokens'))


def failed(res):
    return {'status': 'fail', 'text': 'HTTP %s' % res['status'] if res['status'] else '超时或断连', 'detail': {'error': res.get('error'), 'ms': res['ms']}}


def input_tokens_text(usage):
    """输入 token 连同缓存一起算：上游塞进去的隐藏提示词常常以缓存 token 的形式出现。"""
    if 'input_tokens' in usage:
        cached = (usage.get('cache_read_input_tokens') or 0) + (usage.get('cache_creation_input_tokens') or 0)
        total = (usage.get('input_tokens') or 0) + cached
    elif 'prompt_tokens' in usage:
        total = usage.get('prompt_tokens') or 0
        cached = (usage.get('prompt_tokens_details') or {}).get('cached_tokens') or 0
    else:
        return None
    return '%s（其中缓存 %s）' % (format(total, ','), format(cached, ',')) if cached else format(total, ',')


def check_max_tokens_and_input(model, fmt, vendor, key):
    """一次流式请求同时测两项：max_tokens=16 有没有被遵守，以及上游计了多少输入 token。
    不守上限的上游会先跑完整段再返回，所以不能用非流式请求等结果。"""
    body = body_for(model, fmt, vendor, PROMPT, 16, True)
    res = post('/v1/messages' if fmt == 'anthropic' else '/v1/chat/completions', key, fmt, body, 300, stream=True)
    if res['status'] != 200:
        bad = failed(res)
        return bad, bad
    usage = res['usage'] or {}
    out = output_tokens_of(usage)
    secs = res['ms'] / 1000
    honored = res['stop'] in ('max_tokens', 'length') and (out is None or out <= 64)
    if honored:
        max_check = {'status': 'ok', 'text': '%.1f 秒停下' % secs}
    elif out:
        max_check = {'status': 'fail', 'text': '没停：回了 %s token' % format(out, ',')}
    else:
        max_check = {'status': 'fail', 'text': '没停：%.0f 秒才结束' % secs}
    detail = {'request': body, 'stop_reason': res['stop'], 'usage': usage, 'ms': res['ms']}
    max_check['detail'] = detail
    text = input_tokens_text(usage)
    input_check = {'status': 'info', 'text': text or '上游没返回', 'detail': detail}
    return max_check, input_check


def check_session(model, fmt, vendor, key):
    path = '/v1/messages' if fmt == 'anthropic' else '/v1/chat/completions'
    word = 'ZEBRA-%d' % random.randint(1000, 9999)
    # Claude 关不掉思考，effort 调到 low，免得思考把回答的 token 吃光
    first = post(path, key, fmt, body_for(model, fmt, vendor, 'Remember this code word for later: %s. Reply with just OK.' % word, 300, False, effort='low'), 120)
    if first['status'] != 200:
        return failed(first)
    ask = post(path, key, fmt, body_for(model, fmt, vendor, 'What code word did I ask you to remember earlier? If you have no record of one, reply exactly UNKNOWN.', 400, False, effort='low'), 120)
    if ask['status'] != 200:
        return failed(ask)
    answer = reply_text(fmt, ask['json'])
    if not answer.strip():
        return {'status': 'warn', 'text': '没有回答', 'detail': {'code_word': word, 'answer': ''}}
    leaked = word in answer
    return {'status': 'fail' if leaked else 'ok', 'text': '记得暗号' if leaked else '答不知道',
            'detail': {'code_word': word, 'answer': answer[:300]}}


def extract_artwork(text):
    """交回什么就存什么：整页 HTML 存 .html，否则取 SVG 存 .svg。"""
    m = re.search(r'```html\s*\n([\s\S]*?)```', text)
    if m:
        return 'html', m.group(1)
    m = re.search(r'(<!DOCTYPE html[\s\S]*</html>|<html[\s\S]*</html>)', text, re.I)
    if m:
        return 'html', m.group(1)
    m = re.search(r'<svg[\s\S]*</svg>', text, re.I)
    if m:
        return 'svg', m.group(0)
    return 'none', ''


def external_links(art):
    links = re.findall(r'https?://[^\s"\'<>)]+', art)
    return [u for u in links if not u.startswith('http://www.w3.org/')]


def check_pelican(model, fmt, vendor, key, tier):
    body = body_for(model, fmt, vendor, PROMPT, 16000, True, effort='medium')
    res = post('/v1/messages' if fmt == 'anthropic' else '/v1/chat/completions', key, fmt, body, 900, stream=True)
    if res['status'] != 200:
        bad = failed(res)
        return bad, bad
    text = res.get('text') or ''
    kind, art = extract_artwork(text)
    file_name = None
    if kind != 'none' and len(art.encode()) <= MAX_ART_BYTES:
        safe = re.sub(r'[^A-Za-z0-9._-]', '_', model)
        file_name = 'art/%s-%s.%s' % (safe, tier, kind)
        write_atomic(os.path.join(OUT, file_name), art)
    tokens = output_tokens_of(res['usage']) or 0
    links = external_links(art)
    truncated = res['stop'] not in ('end_turn', 'stop')
    detail = {'request': body, 'stop_reason': res['stop'], 'usage': res['usage'], 'ms': res['ms'],
              'first_text_ms': res['first_text_ms'], 'chars': len(text), 'artwork_bytes': len(art.encode()),
              'external_links': links[:5], 'head': text[:200]}
    pelican = {'status': 'info', 'text': '%d 秒 · %s token' % (round(res['ms'] / 1000), format(tokens, ',')),
               'kind': kind if file_name else 'none', 'file': file_name, 'detail': detail}
    if kind == 'none':
        fmt_check = {'status': 'fail', 'text': '没有交回作品'}
    elif truncated:
        fmt_check = {'status': 'warn', 'text': '被截断'}
    elif kind == 'html':
        fmt_check = {'status': 'warn', 'text': '整页 HTML'}
    elif links:
        fmt_check = {'status': 'warn', 'text': '附带外部链接'}
    else:
        fmt_check = {'status': 'ok', 'text': '静态 SVG' if '<script' not in art.lower() else 'SVG（含脚本）'}
    fmt_check['detail'] = {'kind': kind, 'stop_reason': res['stop'], 'external_links': links[:5]}
    return fmt_check, pelican


def write_atomic(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(content)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    keys = json.load(open(KEYS_FILE))
    pricing = http_json(BASE + '/api/pricing')
    vendors = {v['id']: v['name'] for v in pricing.get('vendors') or []}
    by_name = {m['model_name']: m for m in pricing['data']}
    for model in sys.argv[1:] or MODELS:
        info = by_name.get(model)
        if not info:
            log(model, 'not on sale, skipped')
            continue
        vendor = vendors.get(info.get('vendor_id'), '')
        fmt = 'anthropic' if vendor == 'Anthropic' else 'openai'
        report = {'model': model, 'ran_at': datetime.now(HKT).isoformat(timespec='seconds'), 'prompt': PROMPT, 'lines': {}}
        for tier, word in TIERS.items():
            group = next((g for g in info.get('enable_groups') or [] if word in g), None)
            if not group:
                continue
            key = keys.get(group)
            if not key:
                log(model, tier, 'no test key for group', group)
                continue
            log(model, tier, group, 'start')
            checks = {}
            checks['max_tokens'], checks['input_tokens'] = check_max_tokens_and_input(model, fmt, vendor, key)
            checks['session'] = check_session(model, fmt, vendor, key)
            checks['format'], checks['pelican'] = check_pelican(model, fmt, vendor, key, tier)
            report['lines'][tier] = {'group': group, 'api': fmt, 'checks': checks}
            log(model, tier, 'done', {k: v.get('text') for k, v in checks.items()})
        write_atomic(os.path.join(OUT, 'models', model + '.json'), json.dumps(report, ensure_ascii=False, indent=1))
    log('all done')


if __name__ == '__main__':
    main()
