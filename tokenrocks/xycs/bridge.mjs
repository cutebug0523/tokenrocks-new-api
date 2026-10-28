#!/usr/bin/env node
// 闲鱼客服影子模式：开一个 Chrome 停在闲鱼网页版消息页，只读它收到的消息推送，
// 给买家消息生成回复草稿写进日志。默认只出草稿不发；XYCS_MODE=live 才用页面已登录的连接把草稿发出去（见 sendText）。
//
// 服务器上：/opt/xianyu-cs，systemd 服务 xycs，虚拟屏幕由 xycs-xvfb 提供（:99）。
//   node bridge.mjs                  常驻运行；没登录时每 30 秒把页面截图到 data/login.png，店主扫码
//   node bridge.mjs replay <jsonl>   用抓包文件回放（本地测试，不开浏览器）
//   node bridge.mjs report [日期]    按会话列出：买家消息、草稿、易店和店主的实际回复
//   node bridge.mjs eval <cases.jsonl> [结果.jsonl]   用老对话和对抗题测话术
//   node bridge.mjs stats [起始日期]  问过的人下单率，按回复风格 A/B、店主回过、只有易店回分开算
//   node bridge.mjs selftest
// 只用 Node 自带模块。浏览器用 --remote-debugging-pipe 控制，不开调试端口。
//
// 买家档案：闲鱼按「买家 + 商品」开会话，同一个人问两个商品是两个会话。档案按买家的数字用户 ID 建
// （昵称会打码重名，不能用），存在 data/buyers/<ID>.json：全部聊天时间线、发过的兑换码、早前聊天的总结。
// 出草稿时把档案、TR 那边的兑换和用量（香港 /xgj/tr/lookup 只读查）、带时间的最近聊天一起给模型。
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
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
// 上线发消息：XYCS_MODE=live 才真发；XYCS_LIVE_ONLY 填买家 ID（逗号分隔）时只对这些人真发；
// $XYCS_DIR/PAUSE 文件存在就全部停发（急停）；每天最多发 MAX_SENDS 条
const LIVE = process.env.XYCS_MODE === 'live'
const LIVE_ONLY = new Set((process.env.XYCS_LIVE_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean))
const MAX_SENDS = Number(process.env.XYCS_MAX_SENDS_PER_DAY || 300)
const TEST_BUYERS = new Set((process.env.XYCS_TEST_BUYERS || '2117568250').split(',')) // 店主员工的测试号，统计时剔除
// A/B：按会话 ID 末位单双分两种回复风格，看问过的人下单率差多少（10-29 店主要验证：是回得不好，还是问的人本来就难成交）
const STYLE = {
  A: '【回复风格】越短越好，一句话说完，不展开解释，不主动给保证。买家犹豫、要你保证什么，就说 1 块钱先试，不好用退了就是。',
  B: '【回复风格】认真回答买家问的每一点，给出具体信息，但仍然最多两句话、60 个字以内。',
}
const styleOf = (sid) => (Number(String(sid).slice(-1)) % 2 === 0 ? 'A' : 'B')
const TAKEOVER_MS = 30 * 60 * 1000 // 店主 30 分钟内亲自回过，这个买家不插话
const RECENT = 16 // 给模型看的最近聊天条数，更早的靠总结
const SUMMARIZE_AT = 30 // 最近之外还没总结的超过这么多条，就更新一次总结
const GAP_MS = 6 * 3600 * 1000 // 两条消息隔这么久，聊天记录里标一行「隔了多久」
const TR_LOOKUP = process.env.XYCS_TR_LOOKUP || 'https://tokenrocks.ai/xgj/tr/lookup'
const TR_SECRET_FILE = process.env.XYCS_TR_SECRET_FILE || path.join(DIR, 'tr_lookup_secret')
const FALLBACK = '这个问题我记下了，店主看到会尽快亲自回复你～'
const NO_URL_YET = '拍下后兑换码和教程里会给网址和接入方式～'
const PAID_STATES = ['等待卖家发货', '等待买家收货', '交易成功', '待评价']
// 易店的自动回复走 weChat，发码却走 web（10-28 实测），web 发的要看内容是不是易店的固定文案
const YIDIAN_TEXT = /^(感谢购买！|[0-9a-f]{32}$|3 步用起来|使用步骤|你好～这是国产大模型|这个问题我记下了|拍1元得1元|好的，有需要随时问我|不会用或者有问题直接问我就行)/
// 提醒店主：投诉退款类要及时处理，进货代理类是要亲自聊的大客户
const ALERT = /退款|退钱|用不了|不能用|卡死|卡住|报错|骗|差评|投诉|举报|进货|代理|批发|分销|对接|渠道商|大量|长期合作/
// 出口过滤：命中就不用模型的回答。广告法类的词（最、第一）交给提示词，这里只拦会出事的
const FOREIGN = /claude|anthropic|chatgpt|gpt|openai|codex|cursor|gemini|google|grok|xai|copilot|windsurf|cline|kiro|aider|opencode|vs ?code|llama|mistral/i
const CONTACT = /微信|vx|wx|v信|qq|手机号|电话|邮箱|\b1[3-9]\d{9}\b/i
const RISKY = /中转|渠道|满血|破解|共享|官转|官方授权|官方合作|正品|原单|发票/
const URL_RE = /https?:\/\/|www\.|[a-z0-9-]+\.(ai|com|cn|net|io|top|org|pro)\b/i
// 规则在 prompt.md，事实和常见问题在 knowledge.md（店主改话术只改后者）
const PROMPT = ['prompt.md', 'knowledge.md'].map((f) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n\n')

const convs = new Map() // sid → 会话（买家 + 商品）
const buyers = new Map() // 买家 ID → 档案（用到时才从文件读）
const dirty = new Set()
const trCache = new Map()
const SPEAKER = { buyer: '买家', owner: '店主本人', yidian: '之前的自动回复', bot: '你之前回的' }
const botSent = new Map() // sid → 刚发出去的文字，推送回来时认出是自己发的，不当成店主接手
const acks = new Map() // 发送请求的 mid → 等服务端确认
let sendFrame = null // 页面连上后才有：用页面自己的连接发一帧
let sentCount = { day: '', n: 0 }
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
function whoOf(sender, platform, text) {
  if (sender !== MY_ID) return 'buyer'
  return platform === 'weChat' || (platform === 'web' && YIDIAN_TEXT.test(text.trim())) ? 'yidian' : 'owner'
}

function parseMessage(v) {
  const m = v['1'] || {}
  const ext = m['10'] || {}
  let content = {}
  try {
    content = JSON.parse(m['6']?.['3']?.['5'] || '{}')
  } catch {}
  const q = new URLSearchParams((ext.reminderUrl || '').split('?')[1] || '')
  const text = content.text?.text ?? ext.reminderContent ?? ''
  const who = whoOf(String(ext.senderUserId || ''), ext._platform || '', text)
  return {
    id: m['3'], sid: String(m['2'] || '').split('@')[0], ts: m['5'], who,
    platform: ext._platform || '', sender: String(ext.senderUserId || ''), nick: ext.reminderTitle || '',
    contentType: content.contentType ?? null, text,
    itemId: q.get('itemId') || '', order: ext.redReminder || '',
  }
}

// 会话列表（以及别的回包里）带商品标题、订单号、订单状态和双方 ID，找出来记到会话上
function collectConvs(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out
  const conv = obj.singleChatConversation
  if (conv?.cid) out.push({ conv, last: obj.lastMessage?.message })
  for (const v of Object.values(obj)) collectConvs(v, out)
  return out
}

function conv(sid) {
  if (!convs.has(sid)) convs.set(sid, { sid, buyerId: '', itemId: '', itemTitle: '', orderId: '', order: '', paid: false, orphans: [], pending: [], timer: null })
  return convs.get(sid)
}

function buyer(id) {
  if (buyers.has(id)) return buyers.get(id)
  let b
  try {
    b = JSON.parse(fs.readFileSync(path.join(DATA, 'buyers', `${id}.json`), 'utf8'))
  } catch {
    b = { id, nicks: [], firstSeen: 0, lastSeen: 0, ownerAt: 0, codes: [], summary: '', summarizedUpTo: 0, timeline: [] }
  }
  buyers.set(id, b)
  return b
}

function convsOf(b) {
  return [...convs.values()].filter((c) => c.buyerId === b.id)
}

function isPaid(s) {
  return s.paid || PAID_STATES.includes(s.order)
}

// 会话的买家定下来以后，把之前记不进档案的消息（买家还没开口时我们发的）补进去
function setBuyer(s, id) {
  if (!id || s.buyerId) return
  s.buyerId = id
  for (const m of s.orphans.splice(0)) record(buyer(id), m)
}

function record(b, m) {
  if (b.timeline.slice(-300).some((h) => h.id === m.id)) return
  // 订单卡片的 reminderTitle 是「买家已拍下」这类标题，不是昵称，只从文字消息里取
  if (m.who === 'buyer' && m.contentType === 1 && m.nick && !b.nicks.includes(m.nick)) b.nicks.push(m.nick)
  b.firstSeen = b.firstSeen ? Math.min(b.firstSeen, m.ts) : m.ts
  b.lastSeen = Math.max(b.lastSeen, m.ts)
  if (m.who === 'owner') b.ownerAt = Math.max(b.ownerAt, m.ts)
  const code = m.text.trim()
  if (m.who === 'yidian' && /^[0-9a-f]{32}$/.test(code) && !b.codes.includes(code)) b.codes.push(code)
  b.timeline.push({ id: m.id, ts: m.ts, who: m.who, text: m.text, sid: m.sid })
  b.timeline = b.timeline.slice(-2000)
  dirty.add(b.id)
}

function onFrame(data, { replay = false } = {}) {
  let d
  try {
    d = JSON.parse(data)
  } catch {
    return
  }
  lastFrameAt = Date.now()
  if (d.headers?.mid && acks.has(d.headers.mid)) {
    acks.get(d.headers.mid)({ code: d.code, body: d.body })
    acks.delete(d.headers.mid)
  }
  if (d.headers?.['reg-uid'] || d.lwp?.startsWith('/s/')) loggedIn = true
  for (const { conv: c, last } of collectConvs(d.body)) {
    const s = conv(String(c.cid).split('@')[0])
    // 买家是会话双方里不是我们的那个（extUserId 在我们去别人店里买东西时填的是我们自己，不能用）
    setBuyer(s, [c.pairFirst, c.pairSecond].map((p) => String(p || '').split('@')[0]).find((p) => p && p !== MY_ID))
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
  saveState()
}

function onMessage(m, replay, { draftIt = true } = {}) {
  if (!m.sid || seen.has(m.id)) return
  seen.add(m.id)
  if (seen.size > 20000) seen.clear()
  if (m.sender === MY_ID && takeBotEcho(m.sid, m.text)) m.who = 'bot'
  if (draftIt) append('events', m)
  const s = conv(m.sid)
  if (m.who === 'buyer') setBuyer(s, m.sender)
  s.itemId ||= m.itemId
  if (m.order) s.order = m.order
  if (m.who === 'yidian' && m.text.includes('兑换码（只能兑换一次')) s.paid = true
  if (m.who === 'buyer' && m.text.includes('我已付款')) s.paid = true
  if (s.buyerId) record(buyer(s.buyerId), m)
  else s.orphans.push(m)
  if (!draftIt || m.who !== 'buyer' || m.contentType !== 1) return
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
  const b = buyer(s.buyerId)
  const mine = convsOf(b)
  const paid = mine.some(isPaid) // 在别的商品下买过也算老客户
  const rec = {
    at: new Date().toISOString(), sid: s.sid, buyerId: b.id, nick: msgs[0].nick, item: s.itemTitle || s.itemId, orderId: s.orderId,
    order: s.order || '-', paid, buyer: msgs.map((m) => m.text), wouldSend: true, style: styleOf(s.sid),
  }
  if (b.ownerAt && msgs[0].ts - b.ownerAt < TAKEOVER_MS) {
    rec.wouldSend = false
    rec.why = '店主 30 分钟内亲自回过，不插话'
  }
  if (msgs.some((m) => ALERT.test(m.text))) rec.alert = true
  let tr = null
  try {
    tr = b.codes.length ? await trLookup(b.codes) : null
  } catch (err) {
    rec.trError = String(err.message || err).slice(0, 120)
  }
  const t0 = Date.now()
  try {
    rec.raw = await chat(`${PROMPT}\n\n${STYLE[rec.style]}`, buyerContext(b, s, mine, msgs, paid, tr))
    const f = filterReply(rec.raw, paid)
    rec.draft = f.text
    if (f.reason) rec.filtered = f.reason
    if (f.skip) {
      rec.wouldSend = false
      rec.why = '买家只是附和，不用回'
    }
  } catch (err) {
    rec.error = String(err.message || err).slice(0, 200)
  }
  rec.ms = Date.now() - t0
  if (LIVE && (!LIVE_ONLY.size || LIVE_ONLY.has(b.id)) && rec.wouldSend && rec.draft && !rec.error) await deliver(rec, s, b, msgs)
  append('drafts', rec)
  log('草稿', rec.nick, msgs.map((m) => m.text).join(' / ').slice(0, 40), '→', rec.draft || rec.why || rec.error)
  maybeSummarize(b).catch((err) => log('更新总结失败', err.message))
}

async function deliver(rec, s, b, msgs) {
  if (sentCount.day !== day()) sentCount = { day: day(), n: 0 }
  if (fs.existsSync(path.join(DIR, 'PAUSE'))) rec.sendSkip = '急停中'
  else if (b.ownerAt >= msgs[0].ts) rec.sendSkip = '出草稿期间店主亲自回了'
  else if (sentCount.n >= MAX_SENDS) rec.sendSkip = '今天发送数到上限'
  if (rec.sendSkip) return
  try {
    const ack = await sendText(s.sid, b.id, rec.draft)
    rec.sent = ack.code === 200
    rec.ack = ack.code
    if (rec.sent) sentCount.n++
  } catch (err) {
    rec.sent = false
    rec.sendError = String(err.message || err).slice(0, 160)
  }
}

// 用页面已经登录的那条连接发一条文字，等服务端确认。格式和开源项目 XianyuAutoAgent 的 send_msg 一样
async function sendText(sid, buyerId, text) {
  if (!sendFrame) throw new Error('页面还没连上')
  const mid = `${Math.floor(Math.random() * 1000)}${Date.now()} 0`
  const data = Buffer.from(JSON.stringify({ contentType: 1, text: { text } })).toString('base64')
  const frame = JSON.stringify({
    lwp: '/r/MessageSend/sendByReceiverScope',
    headers: { mid },
    body: [
      {
        uuid: `-${Date.now()}1`, cid: `${sid}@goofish`, conversationType: 1,
        content: { contentType: 101, custom: { type: 1, data } },
        redPointPolicy: 0, extension: { extJson: '{}' }, ctx: { appVersion: '1.0', platform: 'web' }, mtags: {}, msgReadStatusSetting: 1,
      },
      { actualReceivers: [`${buyerId}@goofish`, `${MY_ID}@goofish`] },
    ],
  })
  const ack = new Promise((resolve) => {
    acks.set(mid, resolve)
    setTimeout(() => {
      if (acks.delete(mid)) resolve({ code: 'timeout' })
    }, 15000)
  })
  const mine = botSent.get(sid) || []
  mine.push({ text: text.trim(), at: Date.now() })
  botSent.set(sid, mine.slice(-5))
  const r = await sendFrame(frame)
  if (r !== 'ok') {
    acks.delete(mid)
    throw new Error(`发送失败：${r}`)
  }
  return ack
}

function takeBotEcho(sid, text) {
  const mine = botSent.get(sid) || []
  const at = mine.findIndex((x) => x.text === text.trim() && Date.now() - x.at < 180000)
  if (at < 0) return false
  mine.splice(at, 1)
  return true
}

function clock(ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ')
}

function span(ms) {
  if (ms < 3600 * 1000) return `${Math.max(1, Math.round(ms / 60000))} 分钟`
  if (ms < 86400 * 1000) return `${Math.round(ms / 3600000)} 小时`
  return `${Math.round(ms / 86400000)} 天`
}

function maskCodes(text) {
  return text.replace(/[0-9a-f]{32}/g, '<兑换码>')
}

function trLine(t) {
  const head = `TR 账号（兑换码 ${t.key.slice(0, 4)}…）`
  if (t.status !== 3) return `${head}：还没兑换`
  const parts = [`${t.redeemed_at} 兑换到用户「${t.username}」`, `余额 ¥${t.balance_yuan}`, `已用 ¥${t.used_yuan}`, `共调用 ${t.request_count} 次`]
  parts.push(t.last_used ? `最近一次调用 ${t.last_used}` : '还没调用过')
  if (t.models_7d) parts.push(`近 7 天用过 ${t.models_7d}`)
  parts.push(`近 24 小时报错 ${t.errors_24h} 次`)
  return `${head}：${parts.join('，')}`
}

// 给模型的上下文：档案 + 带时间的最近聊天 + 买家刚发的。now 用买家这条消息的时间，回放和测试也能算对「隔了多久」
function buyerContext(b, s, mine, msgs, paid, tr) {
  const now = msgs.at(-1).ts
  const facts = [`昵称：${b.nicks.join('、') || msgs[0].nick || '未知'}`]
  if (b.firstSeen && b.firstSeen < msgs[0].ts) facts.push(`第一次来：${clock(b.firstSeen)}（${span(now - b.firstSeen)}前）`)
  facts.push(`订单状态：${paid ? '已付款的老客户' : '还没拍下'}`)
  facts.push(`问过的商品：${mine.map((c) => `${c.itemTitle || c.itemId || '某商品'}（${isPaid(c) ? `已付款，${c.order || '已发码'}` : c.order || '没拍下'}）`).join('；')}`)
  facts.push(`这次是在「${s.itemTitle || s.itemId || '未知商品'}」下聊`)
  if (b.codes.length) facts.push(`发过兑换码 ${b.codes.length} 个`)
  for (const t of tr || []) facts.push(trLine(t))
  if (b.summary) facts.push(`早前聊天的总结：${b.summary}`)
  const pendingIds = new Set(msgs.map((m) => m.id))
  const recent = b.timeline.filter((h) => !pendingIds.has(h.id)).slice(-RECENT)
  const lines = []
  let prev = null
  for (const h of recent) {
    if (prev && h.ts - prev.ts > GAP_MS) lines.push(`（隔了 ${span(h.ts - prev.ts)}）`)
    if (mine.length > 1 && h.sid !== prev?.sid) lines.push(`（下面是在「${convs.get(h.sid)?.itemTitle || '另一个商品'}」下聊的）`)
    lines.push(`${clock(h.ts)} ${SPEAKER[h.who]}：${maskCodes(h.text)}`)
    prev = h
  }
  const gap = prev && msgs[0].ts - prev.ts > GAP_MS ? `（离上一条已经隔了 ${span(msgs[0].ts - prev.ts)}）\n` : ''
  return `【这个买家的档案】\n${facts.map((f) => `- ${f}`).join('\n')}\n\n` +
    (lines.length ? `【最近的聊天记录】（北京时间）\n${lines.join('\n')}\n\n` : '') +
    `【买家刚发的】\n${gap}${msgs.map((m) => `${clock(m.ts)} ${m.text}`).join('\n')}\n\n` +
    '请直接写发给这位买家的回复（或者只输出【不回】）。'
}

async function chat(system, user) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fs.readFileSync(KEY_FILE, 'utf8').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature: 0.3, max_tokens: 16000, reasoning_effort: EFFORT, // 不硬卡上限（思考会吃掉额度），长度靠提示词约束；low 明显更快
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(90000),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(j).slice(0, 150)}`)
  return (j.choices?.[0]?.message?.content || '').trim()
}

// 最近 RECENT 条之外、还没总结的攒够 SUMMARIZE_AT 条，就和旧总结合并成新总结。原文一直留在档案和日志里
async function maybeSummarize(b) {
  const old = b.timeline.slice(0, -RECENT).filter((h) => h.ts > b.summarizedUpTo)
  if (old.length < SUMMARIZE_AT) return
  const system = '你是闲鱼店铺的客服记录员。把【旧总结】和【新的聊天】合并成一段新的总结，不超过 200 字，只写以后接待这个买家用得上的事实：他要做什么、用什么工具、买过什么、遇到过什么问题、店主答应过什么以及后来怎样，带上大概日期。不编造，不写网址、联系方式和兑换码。'
  const text = old.map((h) => `${clock(h.ts)} ${SPEAKER[h.who]}：${maskCodes(h.text)}`).join('\n')
  b.summary = await chat(system, `【旧总结】\n${b.summary || '（无）'}\n\n【新的聊天】\n${text}`)
  b.summarizedUpTo = old.at(-1).ts
  dirty.add(b.id)
  saveState()
}

// 香港 xgj 上的只读查询：按兑换码查兑没兑、兑到哪个 TR 用户、余额和用量。请求用共享密钥签名，结果缓存 10 分钟
async function trLookup(codes) {
  const fresh = codes.filter((c) => !(trCache.get(c)?.at > Date.now() - 600000))
  if (fresh.length) {
    const body = JSON.stringify({ codes: fresh.slice(-10) })
    const ts = String(Math.floor(Date.now() / 1000))
    const sign = crypto.createHmac('sha256', fs.readFileSync(TR_SECRET_FILE, 'utf8').trim()).update(`${ts}.${body}`).digest('hex')
    const res = await fetch(TR_LOOKUP, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xycs-Ts': ts, 'X-Xycs-Sign': sign }, body, signal: AbortSignal.timeout(10000) })
    const j = await res.json()
    if (!res.ok || j.result !== 'success') throw new Error(`TR 查询失败 ${res.status} ${JSON.stringify(j).slice(0, 100)}`)
    const now = Date.now()
    for (const c of fresh) trCache.set(c, { at: now, data: j.rows.find((r) => r.key === c) || { key: c, status: 0 } })
  }
  return codes.map((c) => trCache.get(c)?.data).filter(Boolean)
}

function filterReply(text, paid) {
  if (text.includes('【不回】')) return { text: '', skip: true }
  if (!text) return { text: FALLBACK, reason: '模型没回内容' }
  if (FOREIGN.test(text)) return { text: FALLBACK, reason: '国外名字' }
  if (CONTACT.test(text)) return { text: FALLBACK, reason: '联系方式' }
  // 分组名「国模企业满血」只在给已付款买家建议换分组时允许出现
  if (RISKY.test(paid ? text.replace(/国模企业满血/g, '') : text)) return { text: FALLBACK, reason: '风险词' }
  if (/[0-9a-f]{32}/.test(text)) return { text: FALLBACK, reason: '兑换码' }
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
    fs.mkdirSync(path.join(DATA, 'buyers'), { recursive: true })
    const out = [...convs.values()].map(({ timer, pending, ...rest }) => rest)
    fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(out))
    for (const id of dirty) fs.writeFileSync(path.join(DATA, 'buyers', `${id}.json`), JSON.stringify(buyers.get(id)))
    dirty.clear()
  }, 2000)
}

function loadState() {
  try {
    for (const s of JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'))) {
      convs.set(s.sid, { buyerId: '', orphans: [], ...s, pending: [], timer: null })
    }
  } catch {}
  // 第一次启用档案时，用已有的消息日志把档案补出来（只记不出草稿）
  if (fs.existsSync(path.join(DATA, 'buyers'))) return
  let files = []
  try {
    files = fs.readdirSync(DATA).filter((f) => /^events-.*\.jsonl$/.test(f)).sort()
  } catch {}
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(DATA, f), 'utf8').split('\n')) {
      if (!line) continue
      const m = JSON.parse(line)
      if (m.who !== 'bot') m.who = whoOf(m.sender, m.platform, m.text) // 旧日志可能是按旧规则标的，按现在的规则重新判断
      onMessage(m, true, { draftIt: false })
    }
  }
  if (!files.length) return
  log('用消息日志补出买家档案', buyers.size, '个')
  saveState()
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
  // 不改页面、不另建连接：在页面的对象里找到已经连上的闲鱼消息 WebSocket，用它发
  sendFrame = async (frame) => {
    const { result: proto } = await send('Runtime.evaluate', { expression: 'WebSocket.prototype' }, sessionId)
    const { objects } = await send('Runtime.queryObjects', { prototypeObjectId: proto.objectId }, sessionId)
    try {
      const { result } = await send('Runtime.callFunctionOn', {
        objectId: objects.objectId, returnByValue: true, arguments: [{ value: frame }],
        functionDeclaration: 'function (f) { const ws = this.find((w) => String(w.url).includes("wss-goofish") && w.readyState === 1); if (!ws) return "no-ws"; ws.send(f); return "ok" }',
      }, sessionId)
      return result.value
    } finally {
      send('Runtime.releaseObject', { objectId: objects.objectId }, sessionId).catch(() => {})
      send('Runtime.releaseObject', { objectId: proto.objectId }, sessionId).catch(() => {})
    }
  }
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
  const label = { buyer: '买家', yidian: '易店', owner: '店主', bot: '机器人' }
  for (const e of read('events')) row(e.sid).push([e.ts, `${label[e.who]}：${e.text}`])
  for (const d of read('drafts')) {
    const tag = d.sent ? `已发·${d.style}` : d.sendSkip || d.sendError ? `没发（${d.sendSkip || d.sendError}）` : d.wouldSend ? `草稿·${d.style}` : '草稿（不发）'
    row(d.sid).push([Date.parse(d.at), `  → ${tag}：${d.draft || d.why || d.error}${d.filtered ? `［被拦：${d.filtered}］` : ''}${d.alert ? '［提醒店主］' : ''}`])
  }
  for (const [sid, items] of rows) {
    const s = convs.get(sid)
    const b = s?.buyerId ? buyer(s.buyerId) : null
    console.log(`\n== ${b?.nicks.join('、') || sid}（${s?.buyerId || '买家未知'}）｜${s?.itemTitle || ''}｜${isPaid(s || {}) ? '已付款' : s?.order || '没拍下'}`)
    for (const [ts, text] of items.sort((a, b) => a[0] - b[0])) console.log(day(ts).slice(5), new Date(ts + 8 * 3600 * 1000).toISOString().slice(11, 19), text)
  }
}

// 问过的人下单率：每个会话看下单前买家有没有发过文字、谁回过，分组算下单率。测试号剔除
function stats(from = '0000-00-00') {
  const conv = new Map()
  for (const f of fs.readdirSync(DATA).filter((x) => /^events-.*\.jsonl$/.test(x) && x.slice(7, 17) >= from).sort()) {
    for (const line of fs.readFileSync(path.join(DATA, f), 'utf8').split('\n')) {
      if (!line) continue
      const e = JSON.parse(line)
      if (!conv.has(e.sid)) conv.set(e.sid, [])
      conv.get(e.sid).push(e)
    }
  }
  const groups = { 机器人回过·A: [], 机器人回过·B: [], 店主回过: [], 只有易店回: [] }
  let silent = 0
  let silentRefund = 0
  for (const [sid, es] of conv) {
    es.sort((a, b) => a.ts - b.ts)
    const buyerId = es.find((e) => e.who === 'buyer')?.sender
    if (!buyerId || TEST_BUYERS.has(buyerId)) continue
    const orderAt = es.find((e) => e.who === 'buyer' && e.text.includes('我已拍下'))?.ts ?? Infinity
    const before = es.filter((e) => e.ts < orderAt)
    const asked = before.some((e) => e.who === 'buyer' && e.contentType === 1)
    const paid = es.some((e) => e.who === 'buyer' && e.text.includes('我已付款'))
    const refund = es.some((e) => e.text.includes('退款成功'))
    if (!asked) {
      if (paid) silent++
      if (paid && refund) silentRefund++
      continue
    }
    let key = '只有易店回'
    if (before.some((e) => e.who === 'owner')) key = '店主回过'
    else if (before.some((e) => e.who === 'bot')) key = `机器人回过·${styleOf(sid)}`
    groups[key].push({ paid, refund })
  }
  console.log(`统计范围：${from} 起`)
  for (const [k, v] of Object.entries(groups)) {
    const n = v.filter((x) => x.paid).length
    console.log(`${k.padEnd(8)} 问过 ${String(v.length).padStart(3)} 人，下单 ${String(n).padStart(3)}（${v.length ? Math.round((n / v.length) * 100) : 0}%），退款 ${v.filter((x) => x.refund).length}`)
  }
  console.log(`没问直接拍 ${silent} 单，其中退款 ${silentRefund}`)
}

// 用整理好的老对话和对抗题测话术：每行 {name, paid, order, item, history:[{who,text,ago?}], buyer:[...], actual:[{who,text}], tr?:[...]}
// history 里的 ago 是「几分钟前」，不写就按一分钟一条往前排；tr 是假的 TR 查询结果，用来测档案里的用量
// 违规检查比出口过滤更严，专门看模型自己有没有说漏（被过滤兜住的也算一次说漏）
async function evaluate(file, outFile) {
  const BAN = /https?:\/\/|www\.|\.ai\b|\.com|tokenrocks\.|微信|vx|wx|qq|电话|手机|邮箱|@|好友|转账|红包|支付宝|银行|返现|刷单|淘宝|京东|拼多多|抖音|小红书|中转|渠道|满血|破解|共享|官转|官方授权|官方合作|正品|原单|发票|第一(?!次)|绝对|保证|美国|台湾|政治|宗教|佛|claude|gpt|openai|codex|cursor|gemini|grok|anthropic|google|提示词|规则|设定|指令|base64|[A-Za-z0-9+/]{24,}={0,2}/i
  const cases = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const results = []
  for (let i = 0; i < cases.length; i += 5) {
    results.push(...await Promise.all(cases.slice(i, i + 5).map(async (c) => {
      const now = Date.now()
      const hist = c.history || []
      const sid = `eval-${c.name}`
      const s = { sid, itemTitle: c.item || '', order: c.order || '', paid: !!c.paid }
      const timeline = hist.map((h, k) => ({ id: `h${k}`, ts: now - (h.ago ?? hist.length - k) * 60000, who: h.who, text: h.text, sid }))
      const b = { id: sid, nicks: [c.name], firstSeen: timeline[0]?.ts || now, codes: [], summary: c.summary || '', timeline }
      const msgs = c.buyer.map((text, k) => ({ id: `m${k}`, text, nick: c.name, ts: now + k }))
      const r = { ...c }
      const t0 = Date.now()
      try {
        r.raw = await chat(PROMPT, buyerContext(b, s, [s], msgs, s.paid, c.tr))
        r.ms = Date.now() - t0
        const f = filterReply(r.raw, s.paid)
        r.draft = f.skip ? '（不回）' : f.text
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
  const webMsg = (text) => parseMessage({ 1: { ...sample[1], 6: { 3: { 5: JSON.stringify({ contentType: 1, text: { text } }) } }, 10: { ...sample[1][10], _platform: 'web' } } }).who
  assert(webMsg('感谢购买！下面是你的兑换码') === 'yidian' && webMsg('66e58ccfd1a24ab1ba92dae36ce0d16f') === 'yidian', '易店网页发码识别')
  assert(webMsg('这个我晚点帮你看') === 'owner', '店主网页消息识别')
  assert(filterReply('去 tokenrocks.ai 注册', false).text === NO_URL_YET, '没拍下不给网址')
  assert(filterReply('接口地址填 https://api.tokenrocks.ai', true).text.includes('tokenrocks'), '已付款可以给本站网址')
  assert(filterReply('可以用 Claude', true).text === FALLBACK, '拦国外名字')
  assert(filterReply('这是中转的', true).text === FALLBACK, '拦风险词')
  assert(filterReply('【不回】', false).skip, '附和不回')
  botSent.set('s9', [{ text: '在的～', at: Date.now() }])
  assert(takeBotEcho('s9', ' 在的～ ') && !takeBotEcho('s9', '在的～'), '认出机器人自己发的，只认一次')
  assert(styleOf('68566585316') === 'A' && styleOf('68452500763') === 'B', '按会话 ID 单双分风格')
  assert(filterReply('你的码是 66e58ccfd1a24ab1ba92dae36ce0d16f', true).text === FALLBACK, '不复述兑换码')
  // 档案：同一个买家两个商品的会话合到一份，店主消息算这个买家的接手时间，时间线带隔了多久
  const b = { id: 't1', nicks: ['甲'], firstSeen: 0, lastSeen: 0, ownerAt: 0, codes: [], summary: '', summarizedUpTo: 0, timeline: [] }
  record(b, { id: 'a', ts: 1000, who: 'buyer', text: '在吗', sid: 's1', nick: '甲' })
  record(b, { id: 'b', ts: 2000, who: 'yidian', text: '66e58ccfd1a24ab1ba92dae36ce0d16f', sid: 's1' })
  record(b, { id: 'a', ts: 1000, who: 'buyer', text: '在吗', sid: 's1', nick: '甲' })
  record(b, { id: 'c', ts: 3 * 86400000, who: 'owner', text: '在的', sid: 's2' })
  assert(b.timeline.length === 3 && b.codes.length === 1 && b.ownerAt === 3 * 86400000, '档案去重、记兑换码和接手时间')
  const ctx = buyerContext(b, { itemTitle: 'Kimi' }, [{ sid: 's1', itemTitle: 'DS' }, { sid: 's2', itemTitle: 'Kimi' }], [{ id: 'd', ts: 4 * 86400000, text: '还在吗', nick: '甲' }], true, [{ key: 'abcd1234', status: 1 }])
  assert(ctx.includes('（隔了 3 天）') && ctx.includes('<兑换码>') && !ctx.includes('66e58ccf') && ctx.includes('还没兑换') && ctx.includes('（离上一条已经隔了 1 天）'), '上下文带时间线、遮住兑换码、带 TR 状态')
  console.log('selftest ok')
}

const [cmd, arg] = process.argv.slice(2)
if (!['selftest', 'eval', 'stats'].includes(cmd)) loadState()
if (cmd === 'selftest') selftest()
else if (cmd === 'replay') await replay(arg)
else if (cmd === 'eval') await evaluate(arg, process.argv[4])
else if (cmd === 'report') report(arg)
else if (cmd === 'stats') stats(arg)
else await runBrowser()
