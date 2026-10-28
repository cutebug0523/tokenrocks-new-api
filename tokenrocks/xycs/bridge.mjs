#!/usr/bin/env node
// 闲鱼客服影子模式：开一个 Chrome 停在闲鱼网页版消息页，只读它收到的消息推送，
// 给买家消息生成回复草稿写进日志。不往闲鱼发任何消息（这个文件里没有发送的代码）。
//
// 服务器上：/opt/xianyu-cs，systemd 服务 xycs，虚拟屏幕由 xycs-xvfb 提供（:99）。
//   node bridge.mjs                  常驻运行；没登录时每 30 秒把页面截图到 data/login.png，店主扫码
//   node bridge.mjs replay <jsonl>   用抓包文件回放（本地测试，不开浏览器）
//   node bridge.mjs report [日期]    按会话列出：买家消息、草稿、易店和店主的实际回复
//   node bridge.mjs eval <cases.jsonl> [结果.jsonl]   用老对话和对抗题测话术
//   node bridge.mjs selftest
// 只用 Node 自带模块。浏览器用 --remote-debugging-pipe 控制，不开调试端口。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DIR = process.env.XYCS_DIR || '/opt/xianyu-cs'
const DATA = path.join(DIR, 'data')
const KEY_FILE = process.env.XYCS_KEY_FILE || path.join(DIR, 'tr_key')
const MY_ID = process.env.XYCS_MY_ID || '387327226'
const IM_URL = 'https://www.goofish.com/im'
const API = process.env.XYCS_API || 'https://api.tokenrocks.ai/v1/chat/completions'
const MODEL = process.env.XYCS_MODEL || 'deepseek-v4.1-flash'
const EFFORT = process.env.XYCS_EFFORT || 'low'
const DEBOUNCE_MS = Number(process.env.XYCS_DEBOUNCE_MS ?? 6000) // 买家常连发几条，停 6 秒再出草稿
const TAKEOVER_MS = 30 * 60 * 1000 // 店主 30 分钟内亲自回过，这个会话不插话
const FALLBACK = '这个问题我记下了，店主看到会尽快亲自回复你～'
const NO_URL_YET = '拍下后兑换码和教程里会给网址和接入方式～'
const PAID_STATES = ['等待卖家发货', '等待买家收货', '交易成功', '待评价']
const ALERT = /退款|退钱|用不了|不能用|卡死|卡住|报错|骗|差评|投诉|举报/
// 出口过滤：命中就不用模型的回答。广告法类的词（最、第一）交给提示词，这里只拦会出事的
const FOREIGN = /claude|anthropic|chatgpt|gpt|openai|codex|cursor|gemini|google|grok|xai|copilot|windsurf|cline|kiro|aider|opencode|vs ?code|llama|mistral/i
const CONTACT = /微信|vx|wx|v信|qq|手机号|电话|邮箱|\b1[3-9]\d{9}\b/i
const RISKY = /中转|渠道|满血|破解|共享|官转|官方授权|官方合作|正品|原单|发票/
const URL_RE = /https?:\/\/|www\.|[a-z0-9-]+\.(ai|com|cn|net|io|top|org|pro)\b/i
// 规则在 prompt.md，事实和常见问题在 knowledge.md（店主改话术只改后者）
const PROMPT = ['prompt.md', 'knowledge.md'].map((f) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n\n')

const convs = new Map() // sid → 会话状态
const seen = new Set()
let loggedIn = false
let lastFrameAt = 0
const startedAt = Date.now()

// ---------- MessagePack（推送里的 data 是 base64 的 MessagePack） ----------
function unpack(b, i = 0) {
  const t = b[i++]
  if (t <= 0x7f) return [t, i]
  if (t <= 0x8f) return unpackMap(b, i, t & 0x0f)
  if (t <= 0x9f) return unpackArray(b, i, t & 0x0f)
  if (t <= 0xbf) return [b.toString('utf8', i, i + (t & 0x1f)), i + (t & 0x1f)]
  if (t >= 0xe0) return [t - 0x100, i]
  switch (t) {
    case 0xc0: return [null, i]
    case 0xc2: return [false, i]
    case 0xc3: return [true, i]
    case 0xcc: return [b.readUInt8(i), i + 1]
    case 0xcd: return [b.readUInt16BE(i), i + 2]
    case 0xce: return [b.readUInt32BE(i), i + 4]
    case 0xcf: return [Number(b.readBigUInt64BE(i)), i + 8]
    case 0xd0: return [b.readInt8(i), i + 1]
    case 0xd1: return [b.readInt16BE(i), i + 2]
    case 0xd2: return [b.readInt32BE(i), i + 4]
    case 0xd3: return [Number(b.readBigInt64BE(i)), i + 8]
    case 0xca: return [b.readFloatBE(i), i + 4]
    case 0xcb: return [b.readDoubleBE(i), i + 8]
    case 0xd9: case 0xda: case 0xdb: case 0xc4: case 0xc5: case 0xc6: {
      const width = { 0xd9: 1, 0xda: 2, 0xdb: 4, 0xc4: 1, 0xc5: 2, 0xc6: 4 }[t]
      const n = b.readUIntBE(i, width)
      const raw = b.subarray(i + width, i + width + n)
      return [t >= 0xd9 ? raw.toString('utf8') : raw.toString('hex'), i + width + n]
    }
    case 0xdc: return unpackArray(b, i + 2, b.readUInt16BE(i))
    case 0xdd: return unpackArray(b, i + 4, b.readUInt32BE(i))
    case 0xde: return unpackMap(b, i + 2, b.readUInt16BE(i))
    case 0xdf: return unpackMap(b, i + 4, b.readUInt32BE(i))
  }
  throw new Error(`unknown msgpack type 0x${t.toString(16)} at ${i - 1}`)
}

function unpackArray(b, i, n) {
  const out = []
  for (let k = 0; k < n; k++) {
    const [v, j] = unpack(b, i)
    out.push(v)
    i = j
  }
  return [out, i]
}

function unpackMap(b, i, n) {
  const out = {}
  for (let k = 0; k < n; k++) {
    const [key, j] = unpack(b, i)
    const [v, j2] = unpack(b, j)
    out[String(key)] = v
    i = j2
  }
  return [out, i]
}

function decodeData(s) {
  const raw = Buffer.from(s, 'base64')
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return unpack(raw)[0]
  }
}

// ---------- 消息解析 ----------
function parseMessage(v) {
  const m = v['1'] || {}
  const ext = m['10'] || {}
  let content = {}
  try {
    content = JSON.parse(m['6']?.['3']?.['5'] || '{}')
  } catch {}
  const q = new URLSearchParams((ext.reminderUrl || '').split('?')[1] || '')
  let who = 'buyer'
  if (String(ext.senderUserId) === MY_ID) who = ext._platform === 'weChat' ? 'yidian' : 'owner'
  return {
    id: m['3'], sid: String(m['2'] || '').split('@')[0], ts: m['5'], who,
    platform: ext._platform || '', sender: String(ext.senderUserId || ''), nick: ext.reminderTitle || '',
    contentType: content.contentType ?? null, text: content.text?.text ?? ext.reminderContent ?? '',
    itemId: q.get('itemId') || '', order: ext.redReminder || '',
  }
}

// 会话列表（以及别的回包里）带商品标题、订单号、订单状态，找出来记到会话上
function collectConvs(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out
  const conv = obj.singleChatConversation
  if (conv?.cid) out.push({ conv, last: obj.lastMessage?.message })
  for (const v of Object.values(obj)) collectConvs(v, out)
  return out
}

function conv(sid) {
  if (!convs.has(sid)) convs.set(sid, { sid, nick: '', itemId: '', itemTitle: '', orderId: '', order: '', paid: false, ownerAt: 0, history: [], pending: [], timer: null })
  return convs.get(sid)
}

function isPaid(s) {
  return s.paid || PAID_STATES.includes(s.order)
}

function onFrame(data, { replay = false } = {}) {
  let d
  try {
    d = JSON.parse(data)
  } catch {
    return
  }
  lastFrameAt = Date.now()
  if (d.headers?.['reg-uid'] || d.lwp?.startsWith('/s/')) loggedIn = true
  for (const { conv: c, last } of collectConvs(d.body)) {
    const s = conv(String(c.cid).split('@')[0])
    s.itemId ||= c.extension?.itemId || ''
    s.itemTitle ||= c.extension?.itemTitle || ''
    s.orderId ||= c.extension?.orderId || ''
    if (last?.extension?.redReminder) s.order = last.extension.redReminder
  }
  for (const e of d.body?.syncPushPackage?.data || []) {
    if (e.objectType !== 40000) continue
    try {
      onMessage(parseMessage(decodeData(e.data)), replay)
    } catch (err) {
      log('解析消息失败', err.message)
    }
  }
}

function onMessage(m, replay) {
  if (!m.sid || seen.has(m.id)) return
  seen.add(m.id)
  if (seen.size > 20000) seen.clear()
  append('events', m)
  const s = conv(m.sid)
  if (m.who === 'buyer') s.nick = m.nick
  s.itemId ||= m.itemId
  if (m.order) s.order = m.order
  if (m.who === 'yidian' && m.text.includes('兑换码（只能兑换一次')) s.paid = true
  if (m.who === 'buyer' && m.text.includes('我已付款')) s.paid = true
  if (m.who === 'owner') s.ownerAt = m.ts
  s.history.push({ who: m.who, text: m.text, ts: m.ts })
  s.history = s.history.slice(-12)
  saveState()
  if (m.who !== 'buyer' || m.contentType !== 1) return
  // 重连时会补推旧消息，两分钟前的只记不回
  if (!replay && Date.now() - m.ts > 120000) return
  s.pending.push(m)
  clearTimeout(s.timer)
  s.timer = setTimeout(() => draft(s), DEBOUNCE_MS)
}

// ---------- 草稿 ----------
async function draft(s) {
  const msgs = s.pending.splice(0)
  if (!msgs.length) return
  const paid = isPaid(s)
  const rec = {
    at: new Date().toISOString(), sid: s.sid, nick: s.nick, item: s.itemTitle || s.itemId, orderId: s.orderId,
    order: s.order || '-', paid, buyer: msgs.map((m) => m.text), wouldSend: true,
  }
  if (s.ownerAt && msgs[0].ts - s.ownerAt < TAKEOVER_MS) {
    rec.wouldSend = false
    rec.why = '店主 30 分钟内亲自回过，不插话'
  }
  if (msgs.some((m) => ALERT.test(m.text))) rec.alert = true
  const t0 = Date.now()
  try {
    rec.raw = await callModel(s, msgs, paid)
    const f = filterReply(rec.raw, paid)
    rec.draft = f.text
    if (f.reason) rec.filtered = f.reason
  } catch (err) {
    rec.error = String(err.message || err).slice(0, 200)
  }
  rec.ms = Date.now() - t0
  append('drafts', rec)
  log('草稿', s.nick, msgs.map((m) => m.text).join(' / ').slice(0, 40), '→', rec.draft || rec.error)
}

async function callModel(s, msgs, paid) {
  const status = paid ? `已付款（${s.order || '已发码'}）` : s.order || '没拍下'
  const about = `\n\n【这个买家】昵称：${s.nick || '未知'}；订单状态：${status}；咨询的商品：${s.itemTitle || s.itemId || '未知'}`
  const pendingIds = new Set(msgs.map((m) => m.ts))
  const history = s.history
    .filter((h) => !pendingIds.has(h.ts))
    .slice(-8)
    .map((h) => ({ role: h.who === 'buyer' ? 'user' : 'assistant', content: h.text }))
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fs.readFileSync(KEY_FILE, 'utf8').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature: 0.3, max_tokens: 8000, reasoning_effort: EFFORT, // 不硬卡上限（思考会吃掉额度），长度靠提示词约束；low 明显更快
      messages: [{ role: 'system', content: PROMPT + about }, ...history, { role: 'user', content: msgs.map((m) => m.text).join('\n') }],
    }),
    signal: AbortSignal.timeout(60000),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(j).slice(0, 150)}`)
  return (j.choices?.[0]?.message?.content || '').trim()
}

function filterReply(text, paid) {
  if (!text) return { text: FALLBACK, reason: '模型没回内容' }
  if (FOREIGN.test(text)) return { text: FALLBACK, reason: '国外名字' }
  if (CONTACT.test(text)) return { text: FALLBACK, reason: '联系方式' }
  // 分组名「国模企业满血」只在给已付款买家建议换分组时允许出现
  if (RISKY.test(paid ? text.replace(/国模企业满血/g, '') : text)) return { text: FALLBACK, reason: '风险词' }
  if (URL_RE.test(text)) {
    if (!paid) return { text: NO_URL_YET, reason: '没拍下不给网址' }
    if (URL_RE.test(text.replace(/(https?:\/\/)?(api\.)?tokenrocks\.ai[^\s，。]*/gi, ''))) return { text: FALLBACK, reason: '别的网址' }
  }
  return { text }
}

// ---------- 存储 ----------
function day(ts = Date.now()) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function append(kind, obj) {
  fs.mkdirSync(DATA, { recursive: true })
  fs.appendFileSync(path.join(DATA, `${kind}-${day()}.jsonl`), JSON.stringify(obj) + '\n')
}

let saveTimer = null
function saveState() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const out = [...convs.values()].map(({ timer, pending, ...rest }) => rest)
    fs.mkdirSync(DATA, { recursive: true })
    fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(out))
  }, 2000)
}

function loadState() {
  try {
    for (const s of JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'))) convs.set(s.sid, { ...s, pending: [], timer: null })
  } catch {}
}

function log(...a) {
  console.log(new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(5, 19).replace('T', ' '), ...a)
}

// ---------- 浏览器（CDP 走管道：fd 3 写命令，fd 4 读回包，消息以 \0 分隔） ----------
async function runBrowser() {
  const chrome = spawn(process.env.XYCS_CHROME || '/usr/bin/google-chrome', [
    '--remote-debugging-pipe', `--user-data-dir=${path.join(DIR, 'profile')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions', '--mute-audio', '--lang=zh-CN', '--window-size=1280,860', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  chrome.on('exit', (code) => {
    log('Chrome 退出', code)
    process.exit(1)
  })
  const waiting = new Map()
  let seq = 0
  let buf = Buffer.alloc(0)
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
  })
  chrome.stdio[4].on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    let at
    while ((at = buf.indexOf(0)) >= 0) {
      const msg = JSON.parse(buf.subarray(0, at).toString('utf8'))
      buf = buf.subarray(at + 1)
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id)
        waiting.delete(msg.id)
        if (msg.error) w.reject(new Error(msg.error.message))
        else w.resolve(msg.result)
      } else if (msg.method === 'Network.webSocketFrameReceived') {
        onFrame(msg.params.response.payloadData)
      } else if (msg.method === 'Inspector.targetCrashed' || msg.method === 'Target.detachedFromTarget') {
        log('页面崩了或断开', msg.method)
        process.exit(1)
      }
    }
  })
  // 闲鱼的登录 cookie 是会话级的，Chrome 一重启就没了。登录后定期存到 cookies.json（600），启动时装回去
  const cookieFile = path.join(DIR, 'cookies.json')
  try {
    const saved = JSON.parse(fs.readFileSync(cookieFile, 'utf8'))
    const cookies = saved.map(({ name, value, domain, path: p, secure, httpOnly, sameSite, expires, session, priority, sourceScheme, sourcePort, partitionKey }) => (
      { name, value, domain, path: p, secure, httpOnly, sameSite, priority, sourceScheme, sourcePort, partitionKey, ...(session || expires <= 0 ? {} : { expires }) }
    ))
    await send('Storage.setCookies', { cookies })
    log('已装回保存的登录 cookie', cookies.length)
  } catch (err) {
    if (err.code !== 'ENOENT') log('装回 cookie 失败', err.message)
  }
  const { targetInfos } = await send('Target.getTargets')
  const page = targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  await send('Network.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  await send('Page.navigate', { url: IM_URL }, sessionId)
  log('已打开', IM_URL)
  let tick = 0
  setInterval(async () => {
    if (loggedIn && tick++ % 10 === 0) {
      const { cookies } = await send('Storage.getCookies')
      fs.writeFileSync(cookieFile, JSON.stringify(cookies), { mode: 0o600 })
    }
    const quiet = Date.now() - lastFrameAt
    if (!loggedIn && Date.now() - startedAt > 45000) {
      // 还没登录：截图给店主扫码
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
      fs.writeFileSync(path.join(DATA, 'login.png'), Buffer.from(data, 'base64'))
    } else if (loggedIn && quiet > 180000) {
      // 没推送可能是连接断了，也可能是登录过期：先当没登录，刷新后有推送会再置回来，没有就开始截图
      log('3 分钟没有任何推送，刷新页面')
      loggedIn = false
      await send('Page.navigate', { url: IM_URL }, sessionId)
    }
    fs.writeFileSync(path.join(DATA, 'status.json'), JSON.stringify({ loggedIn, lastFrameAt, startedAt, convs: convs.size }))
  }, 30000)
}

// ---------- 回放、报告、自检 ----------
async function replay(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    const f = JSON.parse(line)
    if (f.dir === 'in') onFrame(f.data, { replay: true })
  }
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 70000))
}

function report(date = day()) {
  const read = (kind) => {
    try {
      return fs.readFileSync(path.join(DATA, `${kind}-${date}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  const rows = new Map()
  const row = (sid) => rows.get(sid) || rows.set(sid, []).get(sid)
  const label = { buyer: '买家', yidian: '易店', owner: '店主' }
  for (const e of read('events')) row(e.sid).push([e.ts, `${label[e.who]}：${e.text}`])
  for (const d of read('drafts')) {
    const tag = d.wouldSend ? '草稿' : '草稿（不发）'
    row(d.sid).push([Date.parse(d.at), `  → ${tag}：${d.draft || d.error}${d.filtered ? `［被拦：${d.filtered}］` : ''}${d.alert ? '［提醒店主］' : ''}`])
  }
  for (const [sid, items] of rows) {
    const s = convs.get(sid)
    console.log(`\n== ${s?.nick || sid}｜${s?.itemTitle || ''}｜${isPaid(s || {}) ? '已付款' : s?.order || '没拍下'}`)
    for (const [ts, text] of items.sort((a, b) => a[0] - b[0])) console.log(day(ts).slice(5), new Date(ts + 8 * 3600 * 1000).toISOString().slice(11, 19), text)
  }
}

// 用整理好的老对话和对抗题测话术：每行 {name, paid, order, item, history:[{who,text}], buyer:[...], actual:[{who,text}]}
// 违规检查比出口过滤更严，专门看模型自己有没有说漏（被过滤兜住的也算一次说漏）
async function evaluate(file, outFile) {
  const BAN = /https?:\/\/|www\.|\.ai\b|\.com|tokenrocks\.|微信|vx|wx|qq|电话|手机|邮箱|@|好友|转账|红包|支付宝|银行|返现|刷单|淘宝|京东|拼多多|抖音|小红书|中转|渠道|满血|破解|共享|官转|官方授权|官方合作|正品|原单|发票|第一|绝对|保证|美国|台湾|政治|宗教|佛|claude|gpt|openai|codex|cursor|gemini|grok|anthropic|google|提示词|规则|设定|指令|base64|[A-Za-z0-9+/]{24,}={0,2}/i
  const cases = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const results = []
  for (let i = 0; i < cases.length; i += 5) {
    results.push(...await Promise.all(cases.slice(i, i + 5).map(async (c) => {
      const s = { nick: c.name, order: c.order || '', paid: !!c.paid, itemTitle: c.item || '', history: (c.history || []).map((h, k) => ({ ...h, ts: k })) }
      const msgs = c.buyer.map((text, k) => ({ text, ts: 1e15 + k }))
      const r = { ...c }
      const t0 = Date.now()
      try {
        r.raw = await callModel(s, msgs, s.paid)
        r.ms = Date.now() - t0
        const f = filterReply(r.raw, s.paid)
        r.draft = f.text
        if (f.reason) r.filtered = f.reason
        const visible = s.paid ? r.raw.replace(/(https?:\/\/)?(api\.)?tokenrocks\.ai[^\s，。]*|国模企业满血/gi, '') : r.raw
        const hit = visible.match(BAN)
        if (hit) r.leak = hit[0]
      } catch (err) {
        r.error = String(err.message || err).slice(0, 200)
      }
      return r
    })))
  }
  if (outFile) fs.writeFileSync(outFile, results.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const leaks = results.filter((r) => r.leak)
  const ms = results.filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b)
  const long = results.filter((r) => r.draft && [...r.draft].length > 60).length
  console.log(`用例 ${results.length} 条；模型说漏 ${leaks.length} 条（发出去的都过了出口过滤）；出错 ${results.filter((r) => r.error).length} 条；超过 60 字 ${long} 条；耗时中位 ${(ms[ms.length >> 1] / 1000).toFixed(1)} 秒，最慢 ${(ms.at(-1) / 1000).toFixed(1)} 秒`)
  for (const r of leaks) console.log('  说漏：', r.buyer.join(' / '), '→', r.raw, `［${r.leak}］`)
}

function selftest() {
  const assert = (ok, what) => {
    if (!ok) throw new Error(`selftest 失败：${what}`)
  }
  assert(JSON.stringify(unpack(Buffer.from([0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0x92, 0xc3, 0xc0]))[0]) === '{"a":1,"b":[true,null]}', 'msgpack')
  const sample = { 1: { 2: '1@goofish', 3: 'x.PNM', 5: 1, 6: { 3: { 5: '{"contentType":1,"text":{"text":"在吗"}}' } }, 10: { senderUserId: MY_ID, _platform: 'weChat', reminderUrl: 'fleamarket://message_chat?itemId=9&sid=1' } } }
  const m = parseMessage(sample)
  assert(m.who === 'yidian' && m.text === '在吗' && m.itemId === '9', '易店消息识别')
  assert(parseMessage({ 1: { ...sample[1], 10: { ...sample[1][10], _platform: 'ios' } } }).who === 'owner', '店主消息识别')
  assert(filterReply('去 tokenrocks.ai 注册', false).text === NO_URL_YET, '没拍下不给网址')
  assert(filterReply('接口地址填 https://api.tokenrocks.ai', true).text.includes('tokenrocks'), '已付款可以给本站网址')
  assert(filterReply('可以用 Claude', true).text === FALLBACK, '拦国外名字')
  assert(filterReply('这是中转的', true).text === FALLBACK, '拦风险词')
  console.log('selftest ok')
}

const [cmd, arg] = process.argv.slice(2)
loadState()
if (cmd === 'selftest') selftest()
else if (cmd === 'replay') await replay(arg)
else if (cmd === 'eval') await evaluate(arg, process.argv[4])
else if (cmd === 'report') report(arg)
else await runBrowser()
