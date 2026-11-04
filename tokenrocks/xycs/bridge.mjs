#!/usr/bin/env node
// 闲鱼客服影子模式：开一个 Chrome 停在闲鱼网页版消息页，只读它收到的消息推送，
// 给买家消息生成回复草稿写进日志。默认只出草稿不发；XYCS_MODE=live 才用页面已登录的连接把草稿发出去（见 sendText）。
//
// 服务器上：/opt/xianyu-cs，systemd 服务 xycs，虚拟屏幕由 xycs-xvfb 提供（:99）。
//   node bridge.mjs                  常驻运行；没登录时每 30 秒把页面截图到 data/login.png，店主扫码（每 4 分钟重开换新码）；
//                                    掉登录 3 分钟没自己登回来，往 $XYCS_DIR/notify_url 推一条通知
//   node bridge.mjs replay <jsonl>   用抓包文件回放（本地测试，不开浏览器）
//   node bridge.mjs report [日期]    按会话列出：买家消息、草稿、易店和店主的实际回复
//   node bridge.mjs eval <cases.jsonl> [结果.jsonl]   用老对话和对抗题测话术
//   node bridge.mjs stats [起始日期]  问过的人下单率，按机器人回过、店主回过、只有自动发货回分开算
//   node bridge.mjs funnel [起始日期] 每个商品的浏览 → 想要 → 咨询 → 下单（浏览、想要来自每天一次的商品快照）
//   node bridge.mjs rank [起始日期]   每个搜索词下我们商品排第几（每天快照后查一次，默认排序前 150 条）
//   node bridge.mjs see <图片网址>   用看图模型读一张图（测读图）
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
const IM_URL = process.env.XYCS_IM_URL || 'https://www.goofish.com/im' // 本地测试时指到假页面
const API = process.env.XYCS_API || 'https://api.tokenrocks.ai/v1/chat/completions'
const MODEL = process.env.XYCS_MODEL || 'deepseek-v4.1-flash'
const EFFORT = process.env.XYCS_EFFORT || 'low'
// 每天查搜索名次用的词：买家常搜的短词，加上和我们标题对得上的长词。改了要重启
const RANK_KEYWORDS = ['deepseek', 'kimi', 'glm', 'qwen', 'api', '大模型', '兑换码', 'deepseek api', 'kimi k3', 'glm5.3', 'qwen3.8']
const RANK_PAGES = 5
// XYCS_RANK=0 不查名次：11-04 四、五店（新号）查到一半弹滑块，之后这个页面的接口都卡住，只留老号查
const RANK_ON = process.env.XYCS_RANK !== '0'
const DEBOUNCE_MS = Number(process.env.XYCS_DEBOUNCE_MS ?? 6000) // 买家常连发几条，停 6 秒再出草稿
// 上线发消息：XYCS_MODE=live 才真发；XYCS_LIVE_ONLY 填买家 ID（逗号分隔）时只对这些人真发；
// $XYCS_DIR/PAUSE 文件存在就全部停发（急停）；每天最多发 MAX_SENDS 条
const LIVE = process.env.XYCS_MODE === 'live'
const LIVE_ONLY = new Set((process.env.XYCS_LIVE_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean))
const MAX_SENDS = Number(process.env.XYCS_MAX_SENDS_PER_DAY || 300)
const TEST_BUYERS = new Set((process.env.XYCS_TEST_BUYERS || '2117568250').split(',')) // 店主员工的测试号，统计时剔除
// 10-29 起 A/B 两种风格跑了三天，问过的人下单率 47% 对 49%，没差别，11-01 起合成一种
const STYLE = '【回复风格】先直接答买家问的那一点，一到两句、60 个字以内，不展开，不主动给保证。买家犹豫、要你保证什么，就说 1 块钱先试，不好用退了就是。'
// 读买家发的截图。客服令牌在国模企业满血分组，这个分组能看图的是 glm-5.3-flash；不开思考 12 秒左右，开了要 20~40 秒，读得差不多
const VISION_MODEL = process.env.XYCS_VISION_MODEL || 'glm-5.3-flash'
const TAKEOVER_MS = 30 * 60 * 1000 // 店主 30 分钟内亲自回过，这个买家不插话
const RECENT = 16 // 给模型看的最近聊天条数，更早的靠总结
const SUMMARIZE_AT = 30 // 最近之外还没总结的超过这么多条，就更新一次总结
const GAP_MS = 6 * 3600 * 1000 // 两条消息隔这么久，聊天记录里标一行「隔了多久」
const TR_LOOKUP = process.env.XYCS_TR_LOOKUP || 'https://tokenrocks.ai/xgj/tr/lookup'
const TR_SECRET_FILE = process.env.XYCS_TR_SECRET_FILE || path.join(DIR, 'tr_lookup_secret')
const FALLBACK = '这个问题我记下了，店主看到会尽快亲自回复你～'
const NO_URL_YET = '拍下后兑换码和教程里会给网址和接入方式～'
const OPENER = '在的～想了解什么直接问就行～' // 买家开口的第一句模型判了【不回】时用（比如只发了个「1」）
const PAID_STATES = ['等待卖家发货', '等待买家收货', '交易成功', '待评价']
// 自动发货（内部仍叫 yidian）：易店的自动回复走 weChat，发码走 web（10-28 实测）；闲管家发码推送里没有 platform（10-31 实测）。
// web 和没有 platform 的要看内容是不是发货的固定文案；一条里多个码（易店的【卡密列表】、闲管家多件）也算
const AUTO_TEXT = /^(感谢购买！|[0-9a-f]{32}(\s|$)|3 步用起来|使用步骤|你好～这是国产大模型|这个问题我记下了|拍1元得1元|好的，有需要随时问我|不会用或者有问题直接问我就行)/
// 提醒店主：投诉退款类要及时处理，进货代理类是要亲自聊的大客户
const ALERT = /退款|退钱|用不了|不能用|卡死|卡住|报错|骗|差评|投诉|举报|进货|代理|批发|分销|对接|渠道商|长期合作/ // 不含「大量」：买家问「多大量」多半是问 1 块钱能跑多少
// 出口过滤：命中就不用模型的回答。广告法类的词（最、第一）交给提示词，这里只拦会出事的
const FOREIGN = /claude|anthropic|chatgpt|gpt|openai|codex|cursor|gemini|google|grok|xai|copilot|windsurf|cline|kiro|aider|opencode|vs ?code|llama|mistral/i
const CONTACT = /微信|vx|wx|v信|qq|手机号|电话|联系方式|\b1[3-9]\d{9}\b/i // 不含邮箱：注册就是用邮箱
const RISKY = /中转|渠道|满血版|破解|共享|官转|官方授权|官方合作|正品|原单|发票/ // 分组名「国模企业满血」可以说
// 闲鱼把卖 Token / API Key 算违规（11-01 Kimi 链接因此被删），聊天里不说这类词，配置细节让买家看网站文档
const KEY_WORDS = /密钥|\bapi\b|\bkey\b|\bsk-|接口地址|令牌/i
const URL_RE = /https?:\/\/|www\.|[a-z0-9-]+\.(ai|com|cn|net|io|top|org|pro)\b/i
// 规则在 prompt.md，事实和常见问题在 knowledge.md（店主改话术只改后者）
// 每次出草稿时现读（两个文件共二十几 KB），改话术不用重启：重启一店可能掉登录要重新扫码
const prompt = () => ['prompt.md', 'knowledge.md'].map((f) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n\n')

const convs = new Map() // sid → 会话（买家 + 商品）
const buyers = new Map() // 买家 ID → 档案（用到时才从文件读）
const dirty = new Set()
const trCache = new Map()
const SPEAKER = { buyer: '买家', owner: '店主本人', yidian: '之前的自动回复', bot: '你之前回的', system: '系统提示' }
const botSent = new Map() // sid → 刚发出去的文字，推送回来时认出是自己发的，不当成店主接手
const acks = new Map() // 发送请求的 mid → 等服务端确认
let sendFrame = null // 页面连上后才有：用页面自己的连接发一帧
let listOurItems = null // 页面连上后才有：拉一次自己店里在售的商品 ID
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
// 店主号发出的：文字、图片、语音才是店主本人；评价、拍下未付款、防诈提示这类卡片是系统发的，不算店主接手
function whoOf(sender, platform, text, contentType) {
  if (sender !== MY_ID) return 'buyer'
  if (![1, 2, 3].includes(contentType)) return 'system'
  return platform === 'weChat' || (['web', ''].includes(platform) && AUTO_TEXT.test(text.trim())) ? 'yidian' : 'owner'
}

// 图片消息的内容里找图片地址（字段名没抓到过样本，按网址找）
function imageUrl(content) {
  return JSON.stringify(content).match(/https?:\/\/[^"\\\s]+/)?.[0] || ''
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
  const contentType = content.contentType ?? null
  const who = whoOf(String(ext.senderUserId || ''), ext._platform || '', text, contentType)
  const image = contentType === 2 ? imageUrl(content) : ''
  if (contentType === 2 && !image) log('图片消息里没找到网址', JSON.stringify(content).slice(0, 300))
  return {
    id: m['3'], sid: String(m['2'] || '').split('@')[0], ts: m['5'], who,
    platform: ext._platform || '', sender: String(ext.senderUserId || ''), nick: ext.reminderTitle || '',
    contentType, text, ...(image ? { image } : {}),
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
  if (m.who === 'yidian') for (const code of m.text.match(/\b[0-9a-f]{32}\b/g) || []) if (!b.codes.includes(code)) b.codes.push(code)
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
  // 店主自己去别人店里买东西：拍下卡片是我们发的，这个会话里对方是卖家，不替店主回
  if (m.sender === MY_ID && m.text.includes('我已拍下')) s.weBuy = true
  if (s.buyerId) record(buyer(s.buyerId), m)
  else s.orphans.push(m)
  if (!draftIt || m.who !== 'buyer' || !(m.contentType === 1 || m.image)) return
  // 重连时会补推旧消息，两分钟前的只记不回
  if (!replay && Date.now() - m.ts > 120000) return
  s.pending.push(m)
  clearTimeout(s.timer)
  s.timer = setTimeout(() => draft(s), DEBOUNCE_MS)
}

// ---------- 草稿 ----------
// 一个会话同时只写一份：上一份还在写（读图、等模型要好几秒），过 2 秒再来，这期间的新消息留在 pending 里一起答
async function draft(s) {
  if (s.busy) return void (s.timer = setTimeout(() => draft(s), 2000))
  s.busy = true
  try {
    await draftOnce(s)
  } finally {
    s.busy = false
  }
}

async function draftOnce(s) {
  const msgs = s.pending.splice(0)
  if (!msgs.length || s.weBuy) return
  if (await notOurItem(s.itemId)) return log('不是自己店的商品，不替人回', s.itemId, msgs[0].nick)
  const b = buyer(s.buyerId)
  // 截图先让看图模型读成文字，档案里那条「[图片]」也换掉，后面每次出草稿都看得到（放回来重答的已经读过）
  for (const m of msgs.filter((x) => x.image && !x.text.startsWith('[图片，'))) {
    try {
      m.text = `[图片，系统读出来的内容：${maskSecrets(await describeImage(m.image))}]`
    } catch (err) {
      m.text = '[图片，没读出来]'
      log('读图失败', String(err.message || err).slice(0, 160))
    }
    const h = b.timeline.find((x) => x.id === m.id)
    if (h) h.text = m.text
    dirty.add(b.id)
  }
  const mine = convsOf(b)
  const paid = mine.some(isPaid) // 在别的商品下买过也算老客户
  const rec = {
    at: new Date().toISOString(), sid: s.sid, buyerId: b.id, nick: msgs[0].nick, item: s.itemTitle || s.itemId, orderId: s.orderId,
    order: s.order || '-', paid, buyer: msgs.map((m) => m.text), wouldSend: true,
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
  // 模型偶尔超时或上游维护，等一会儿再试一次；还不行就回兜底那句并提醒店主，不让买家干等
  for (let attempt = 1; attempt <= 2 && rec.raw === undefined; attempt++) {
    try {
      rec.raw = await chat(`${prompt()}\n\n${STYLE}`, buyerContext(b, s, mine, msgs, paid, tr))
    } catch (err) {
      rec.error = String(err.message || err).slice(0, 200)
      if (attempt === 1) await new Promise((r) => setTimeout(r, 8000))
    }
  }
  if (rec.raw !== undefined) {
    delete rec.error
    const f = filterReply(rec.raw, paid)
    rec.draft = f.text
    if (f.reason) rec.filtered = f.reason
    if (f.skip && !hasReplied(b, s.sid)) {
      rec.draft = OPENER
      rec.filtered = '开口第一句不能不回'
    } else if (f.skip) {
      rec.wouldSend = false
      rec.why = '买家只是附和，不用回'
    }
  } else if (lastBotText(b, s.sid) !== FALLBACK) {
    rec.draft = FALLBACK
    rec.alert = true
  }
  // 「记下了，等店主」一段对话只说一次，店主回过之后才能再说
  if (rec.wouldSend && /记下了/.test(rec.draft || '') && saidNoted(b, s.sid)) {
    rec.wouldSend = false
    rec.why = '已经说过记下了，等店主回'
  }
  rec.ms = Date.now() - t0
  // 写的时候买家又发了新消息：这份不发，消息放回去跟新的一起重答，免得连回几条、答过时的问题
  if (rec.wouldSend && s.pending.length) {
    s.pending.unshift(...msgs)
    rec.wouldSend = false
    rec.why = '写的时候买家又发了，合起来重答'
  }
  if (LIVE && (!LIVE_ONLY.size || LIVE_ONLY.has(b.id)) && rec.wouldSend && rec.draft) await deliver(rec, s, b, msgs)
  append('drafts', rec)
  log('草稿', rec.nick, msgs.map((m) => m.text).join(' / ').slice(0, 40), '→', rec.draft || rec.why || rec.error)
  maybeSummarize(b).catch((err) => log('更新总结失败', err.message))
}

// 会话里的商品不是自己店的，说明这个号在别人那儿当买家（比如二店号去一店问过话），不替对方当客服，不然两个机器人会互相回。
// 先看历次商品快照，没有再拉一次在售列表（10 分钟最多一次，刚上架的商品当天快照里还没有）；拉不到就照常回
const ourItems = new Set()
let ourItemsAt = 0
async function notOurItem(id) {
  if (!ourItems.size) for (const r of readLogs('items', '0000-00-00')) ourItems.add(String(r.id))
  if (!id || ourItems.has(String(id))) return false
  if (!listOurItems || Date.now() - ourItemsAt < 600000) return ourItems.size > 0
  ourItemsAt = Date.now()
  try {
    for (const x of await listOurItems()) ourItems.add(String(x))
  } catch (err) {
    log('拉在售商品失败', err.message)
    return false
  }
  return !ourItems.has(String(id))
}

// 这个会话里有没有人（机器人、店主、自动发货）回过买家
function hasReplied(b, sid) {
  return b.timeline.some((h) => h.sid === sid && !['buyer', 'system'].includes(h.who))
}

// 店主上次说话之后，机器人在这个会话里说过「记下了」没有
function saidNoted(b, sid) {
  for (let i = b.timeline.length - 1; i >= 0; i--) {
    const h = b.timeline[i]
    if (h.sid !== sid) continue
    if (h.who === 'owner') return false
    if (h.who === 'bot' && /记下了/.test(h.text)) return true
  }
  return false
}

// 这个会话里机器人最近一次说的话；模型连续失败时，同一句兜底不重复发
function lastBotText(b, sid) {
  return b.timeline.findLast((h) => h.sid === sid && h.who === 'bot')?.text
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
  let done
  const ack = new Promise((resolve) => {
    done = resolve
    acks.set(mid, resolve)
  })
  const mine = botSent.get(sid) || []
  mine.push({ text: text.trim(), at: Date.now() })
  botSent.set(sid, mine.slice(-5))
  // 页面刚崩了正在重开时，消息连接要几秒才连上：每 5 秒试一次，最多等 1 分钟
  let r
  for (let i = 0; i < 12 && (r = await sendFrame(frame).catch((err) => err.message)) !== 'ok'; i++) await new Promise((res) => setTimeout(res, 5000))
  if (r !== 'ok') {
    acks.delete(mid)
    throw new Error(`发送失败：${r}`)
  }
  setTimeout(() => {
    if (acks.delete(mid)) done({ code: 'timeout' })
  }, 15000)
  const res = await ack
  // 自己发的消息服务端不会再推回这个页面（10-29 实测），确认成功后直接记进日志和档案
  if (res.code === 200 && res.body?.messageId) {
    onMessage({ id: res.body.messageId, sid, ts: res.body.createAt || Date.now(), who: 'bot', platform: 'web', sender: MY_ID, nick: '', contentType: 1, text, itemId: '', order: '' }, false)
  }
  return res
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

// 截图里常带买家的密钥，读出来的文字再遮一遍
function maskSecrets(text) {
  return maskCodes(text).replace(/sk-[A-Za-z0-9_-]{6,}/g, '<已打码>')
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
  if (b.codes.length) facts.push(`发过兑换码 ${b.codes.length} 个${b.codes.length > 10 ? '，下面只列最近 10 个' : ''}`)
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

async function chat(system, user, model = MODEL, effort = EFFORT) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fs.readFileSync(KEY_FILE, 'utf8').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, temperature: 0.3, max_tokens: 16000, reasoning_effort: effort, // 不硬卡上限（思考会吃掉额度），长度靠提示词约束；low 明显更快
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(90000),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(j).slice(0, 150)}`)
  return (j.choices?.[0]?.message?.content || '').trim()
}

// 图片下载下来转成 data URL 给看图模型，不让上游自己去闲鱼的图床拉
async function describeImage(url) {
  const img = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!img.ok) throw new Error(`下载图片 HTTP ${img.status}`)
  const buf = Buffer.from(await img.arrayBuffer())
  if (buf.length > 6e6) throw new Error(`图片太大 ${buf.length}`)
  const type = (img.headers.get('content-type') || 'image/jpeg').split(';')[0]
  const system = '你在帮闲鱼店铺的客服看买家发来的图片，多半是软件设置页、报错或网站页面的截图。用中文写出图里跟买家问题有关的内容：是什么软件或网页的哪个页面、各栏填了什么、选了什么、报错原文照抄。密钥、兑换码、密码、手机号、邮箱一律写成<已打码>。看不清的就说看不清，不猜图外的事，不给建议，150 字以内。'
  return chat(system, [{ type: 'text', text: '这张图里是什么？' }, { type: 'image_url', image_url: { url: `data:${type};base64,${buf.toString('base64')}` } }], VISION_MODEL, 'none')
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
    for (const c of fresh.slice(-10)) trCache.set(c, { at: now, data: j.rows.find((r) => r.key === c) || { key: c, status: 0 } })
  }
  return codes.map((c) => trCache.get(c)?.data).filter(Boolean)
}

function filterReply(text, paid) {
  if (text.includes('【不回】')) return { text: '', skip: true }
  if (!text) return { text: FALLBACK, reason: '模型没回内容' }
  if (FOREIGN.test(text)) return { text: FALLBACK, reason: '国外名字' }
  if (CONTACT.test(text)) return { text: FALLBACK, reason: '联系方式' }
  if (RISKY.test(text)) return { text: FALLBACK, reason: '风险词' }
  if (KEY_WORDS.test(text)) return { text: FALLBACK, reason: '密钥类词' }
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
    const out = [...convs.values()].map(({ timer, pending, busy, ...rest }) => rest)
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
      if (m.who !== 'bot') m.who = whoOf(m.sender, m.platform, m.text, m.contentType) // 旧日志可能是按旧规则标的，按现在的规则重新判断
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

// 推到店主手机：$XYCS_DIR/notify_url（600）放推送地址，Bark 的 https://api.day.app/<key> 或 Server酱的 https://sctapi.ftqq.com/<key>.send 都行
async function notify(title, body) {
  log('通知店主', title, body)
  let url
  try {
    url = fs.readFileSync(path.join(DIR, 'notify_url'), 'utf8').trim()
  } catch {
    return log('没配 notify_url，通知没发出去')
  }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body, desp: body, level: 'critical' }), signal: AbortSignal.timeout(10000) })
    if (!res.ok) log('通知发送失败', res.status)
  } catch (err) {
    log('通知发送失败', err.message)
  }
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
  const crashes = []
  let seq = 0
  let buf = Buffer.alloc(0)
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
    // 页面崩的那一刻还没回的命令可能永远等不到回包，别让发送一直挂着
    setTimeout(() => {
      if (waiting.delete(id)) reject(new Error(`${method} 60 秒没回`))
    }, 60000)
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
      } else if (msg.method === 'Inspector.targetCrashed') {
        // 只是渲染进程崩了，Chrome 还在，内存里的登录也还在：原地重开页面。重启 Chrome 就得靠装回 cookie，登录过了一天就装不回（11-01 17:00）
        crashes.push(Date.now())
        while (Date.now() - crashes[0] > 3600000) crashes.shift()
        log('页面崩了，原地重开', `近一小时第 ${crashes.length} 次`)
        if (crashes.length > 3) process.exit(1)
        loggedIn = false
        open().catch((err) => {
          log('重开失败', err.message)
          process.exit(1)
        })
      } else if (msg.method === 'Target.detachedFromTarget') {
        log('页面断开')
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
  let navAt = 0
  const open = () => {
    navAt = Date.now()
    return send('Page.navigate', { url: IM_URL }, sessionId)
  }
  await send('Network.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  // 扫码后闲鱼问「保持登录状态」，8 秒不选就算「不保持」，那样登录只撑一天左右，过后重开页面就得重扫（10-29、11-01 都是）。
  // 每个页面和登录小窗里都盯着，弹出来就点「保持」：拿到 30 天的免登凭证 havana_lgc2_77，登录过期时页面会自己静默登回去
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'setInterval(() => document.querySelector("button.keep-login-confirm-btn.primary")?.click(), 500)' }, sessionId)
  // 不改页面、不另建连接：在页面的对象里找到已经连上的闲鱼消息 WebSocket，用它发。
  // 找连接要扫一遍页面内存（queryObjects），每条都扫会把页面扫崩（11-01 00:03、17:00 都崩在发送那一刻），所以找到后一直用它，断了才重找
  let wsId = null
  const viaWs = async (frame) => {
    const { result } = await send('Runtime.callFunctionOn', {
      objectId: wsId, returnByValue: true, arguments: [{ value: frame }],
      functionDeclaration: 'function (f) { if (this.readyState !== 1) return "closed"; this.send(f); return "ok" }',
    }, sessionId)
    return result.value
  }
  sendFrame = async (frame) => {
    if (wsId && (await viaWs(frame).catch(() => '')) === 'ok') return 'ok'
    if (wsId) send('Runtime.releaseObject', { objectId: wsId }, sessionId).catch(() => {})
    wsId = null
    const { result: proto } = await send('Runtime.evaluate', { expression: 'WebSocket.prototype' }, sessionId)
    const { objects } = await send('Runtime.queryObjects', { prototypeObjectId: proto.objectId }, sessionId)
    try {
      const { result } = await send('Runtime.callFunctionOn', {
        objectId: objects.objectId,
        functionDeclaration: 'function () { return this.find((w) => String(w.url).includes("wss-goofish") && w.readyState === 1) }',
      }, sessionId)
      if (!result.objectId) return 'no-ws'
      wsId = result.objectId
    } finally {
      send('Runtime.releaseObject', { objectId: objects.objectId }, sessionId).catch(() => {})
      send('Runtime.releaseObject', { objectId: proto.objectId }, sessionId).catch(() => {})
    }
    return viaWs(frame)
  }
  // 闲鱼的 mtop 接口：在页面里带登录态发，签名是 md5(_m_h5_tk 前半段&时间&appKey&data)；token 过期时回包会换新 cookie，重试一次
  const mtop = async (api, data, retry = true) => {
    const { cookies } = await send('Storage.getCookies')
    const tk = (cookies.find((c) => c.name === '_m_h5_tk')?.value || '').split('_')[0]
    const body = JSON.stringify(data)
    const t = Date.now()
    const sign = crypto.createHash('md5').update(`${tk}&${t}&34839810&${body}`).digest('hex')
    const url = `https://h5api.m.goofish.com/h5/${api}/1.0/?jsv=2.7.2&appKey=34839810&t=${t}&sign=${sign}&v=1.0&type=originaljson&accountSite=xianyu&dataType=json&timeout=20000&api=${api}&sessionOption=AutoLoginOnly`
    const init = { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(body)}` }
    const { result } = await send('Runtime.evaluate', { expression: `fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then((r) => r.text())`, awaitPromise: true, returnByValue: true }, sessionId)
    const r = JSON.parse(result.value)
    if (String(r.ret?.[0]).startsWith('SUCCESS')) return r.data
    if (retry && /TOKEN/.test(r.ret)) return mtop(api, data, false)
    throw new Error(`${api} ${r.ret}`)
  }
  listOurItems = async () => ((await mtop('mtop.idle.web.xyh.item.list', { needGroupInfo: false, pageNumber: 1, userId: MY_ID, pageSize: 20 })).cardList || []).map((x) => x.cardData.id)
  // 商品快照：每天（北京时间）第一次跑到这里时，给每个在售商品记一次浏览、想要、标题、主图，写 data/items-<日期>.jsonl。
  // 详情接口每调一次浏览就 +1（店主自己看也算），所以一天只拍一次，funnel 报表里扣掉
  let snapTried = ''
  const snapshot = async () => {
    const { cardList = [] } = await mtop('mtop.idle.web.xyh.item.list', { needGroupInfo: false, pageNumber: 1, userId: MY_ID, pageSize: 20 }) // 一页最多 20 个，店里在售的没这么多
    for (const { cardData: c } of cardList) {
      const { itemDO: d = {}, trackParams: tp = {} } = await mtop('mtop.taobao.idle.pc.detail', { itemId: c.id })
      append('items', { at: Date.now(), id: c.id, title: d.title, pic: tp.mainPic || c.detailParams?.picUrl, browse: d.browseCnt, want: d.wantCnt, status: d.itemStatusStr })
    }
    log('商品快照', cardList.length, '个')
  }
  // 搜索名次：当天商品快照之后查一次，每个词翻 RANK_PAGES 页（一页约 30 条），每页隔 10 秒免得触发风控。
  // 每个词一行写 data/rank-<日期>.jsonl：我们商品的名次，加上前 3 名是谁、是不是广告位（isAliMaMaAD）
  let rankTried = ''
  const rank = async () => {
    const mine = new Set(readLogs('items', day()).map((r) => r.id))
    for (const kw of RANK_KEYWORDS) {
      const ranks = {}
      const top = []
      let n = 0
      for (let p = 1; p <= RANK_PAGES; p++) {
        const { resultList = [] } = await mtop('mtop.taobao.idlemtopsearch.pc.search', { pageNumber: p, keyword: kw, fromFilter: false, rowsPerPage: 30, sortValue: '', sortField: '', customDistance: '', gps: '', propValueStr: {}, customGps: '', searchReqFromPage: 'pcSearch', extraFilterValue: '{}', userPositionJson: '{}' })
        for (const x of resultList) {
          const { clickParam: { args = {} } = {}, exContent: ex = {} } = x.data?.item?.main || {}
          n++
          if (mine.has(args.id) && !ranks[args.id]) ranks[args.id] = n
          if (top.length < 3) top.push({ id: args.id, title: String(ex.title || '').slice(0, 40), price: args.price, ad: !!ex.isAliMaMaAD })
        }
        await new Promise((r) => setTimeout(r, 10000))
      }
      append('rank', { at: Date.now(), kw, scanned: n, ranks, top })
    }
    log('搜索名次', RANK_KEYWORDS.length, '个词')
  }
  await open()
  log('已打开', IM_URL)
  let tick = 0
  let keepUntil
  let outSince = 0
  let notifiedAt = 0
  const every30s = async () => {
    if (loggedIn && tick++ % 10 === 0) {
      const { cookies } = await send('Storage.getCookies')
      fs.writeFileSync(cookieFile, JSON.stringify(cookies), { mode: 0o600 })
      const keep = cookies.find((c) => c.name.startsWith('havana_lgc2_'))?.expires || 0
      if (keep !== keepUntil) log(keep ? `有免登凭证，到 ${clock(keep * 1000)}` : '没有免登凭证，登录过期就得重新扫码')
      keepUntil = keep
    }
    // 手动发一条：root 往 $XYCS_DIR/ctl/send.json 写 {sid, buyerId, text}，这里发出去，结果写到 data/ctl-result.json
    const ctl = path.join(DIR, 'ctl', 'send.json')
    if (loggedIn && fs.existsSync(ctl)) {
      let result
      try {
        const c = JSON.parse(fs.readFileSync(ctl, 'utf8'))
        fs.unlinkSync(ctl)
        result = { at: new Date().toISOString(), ...c, ...(await sendText(String(c.sid), String(c.buyerId), String(c.text))) }
      } catch (err) {
        result = { at: new Date().toISOString(), error: String(err.message || err) }
      }
      fs.writeFileSync(path.join(DATA, 'ctl-result.json'), JSON.stringify(result))
      log('手动发送', JSON.stringify(result).slice(0, 160))
    }
    // 手动查一个闲鱼接口（只读，排查字段用）：root 往 $XYCS_DIR/ctl/mtop.json 写 {api, data}，原始返回写到 data/ctl-mtop.json
    const probe = path.join(DIR, 'ctl', 'mtop.json')
    if (loggedIn && fs.existsSync(probe)) {
      let result
      try {
        const c = JSON.parse(fs.readFileSync(probe, 'utf8'))
        fs.unlinkSync(probe)
        if (/create|edit|update|delete|remove|publish|send|modify|set|add|cancel|confirm|refund/i.test(c.api)) throw new Error('只允许只读接口')
        result = { at: new Date().toISOString(), api: c.api, data: await mtop(c.api, c.data || {}) }
      } catch (err) {
        result = { at: new Date().toISOString(), error: String(err.message || err) }
      }
      fs.writeFileSync(path.join(DATA, 'ctl-mtop.json'), JSON.stringify(result))
      log('手动查接口', JSON.stringify(result).slice(0, 160))
    }
    // 失败不在当天重试（重试会多刷浏览），重启服务会再试一次
    if (loggedIn && snapTried !== day() && !fs.existsSync(path.join(DATA, `items-${day()}.jsonl`))) {
      snapTried = day()
      snapshot().catch((err) => log('商品快照失败', err.message))
    }
    if (RANK_ON && loggedIn && rankTried !== day() && fs.existsSync(path.join(DATA, `items-${day()}.jsonl`)) && !fs.existsSync(path.join(DATA, `rank-${day()}.jsonl`))) {
      rankTried = day()
      rank().catch((err) => log('搜索名次失败', err.message))
    }
    const quiet = Date.now() - lastFrameAt
    if (!loggedIn && Date.now() - navAt > 240000) {
      // 二维码几分钟就失效（截到的是「二维码已失效」），每 4 分钟重开一次换新码，也让页面再试一次免登
      await open()
    } else if (!loggedIn && Date.now() - startedAt > 45000) {
      // 还没登录：截图给店主扫码
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
      fs.writeFileSync(path.join(DATA, 'login.png'), Buffer.from(data, 'base64'))
    } else if (loggedIn && quiet > 180000) {
      // 没推送可能是连接断了，也可能是登录过期：先当没登录，刷新后有推送会再置回来，没有就开始截图
      log('3 分钟没有任何推送，刷新页面')
      loggedIn = false
      await open()
    }
    // 掉登录 3 分钟还没自己登回来（免登、重开页面都不管用）才叫店主扫码，没扫就每小时再叫一次
    if (loggedIn) {
      if (notifiedAt) notify('闲鱼客服登录恢复了', '买家消息又能自动回了')
      outSince = notifiedAt = 0
    } else if (!outSince) {
      outSince = Date.now()
    } else if (Date.now() - outSince > 180000 && Date.now() - notifiedAt > 3600000) {
      notifiedAt = Date.now()
      notify('闲鱼客服掉登录了，要扫码', `已经 ${span(Date.now() - outSince)} 收不到买家消息，自动登录没成功。二维码在杭州服务器 /opt/xianyu-cs/data/login.png，用闲鱼 App 扫`)
    }
    fs.writeFileSync(path.join(DATA, 'status.json'), JSON.stringify({ loggedIn, lastFrameAt, startedAt, convs: convs.size, keepLoginUntil: keepUntil ? keepUntil * 1000 : 0 }))
  }
  // 定时检查里一步出错（比如页面正在重开）只记一笔，不能让整个进程退出把登录丢了
  setInterval(() => every30s().catch((err) => log('定时检查出错', err.message)), 30000)
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
  const label = { buyer: '买家', yidian: '自动发货', owner: '店主', bot: '机器人', system: '系统' }
  for (const e of read('events')) row(e.sid).push([e.ts, `${label[e.who]}：${e.text}`])
  for (const d of read('drafts')) {
    const tag = d.sent ? '已发' : d.sendSkip || d.sendError ? `没发（${d.sendSkip || d.sendError}）` : d.wouldSend ? '草稿' : '草稿（不发）'
    row(d.sid).push([Date.parse(d.at), `  → ${tag}：${d.draft || d.why || d.error}${d.filtered ? `［被拦：${d.filtered}］` : ''}${d.alert ? '［提醒店主］' : ''}`])
  }
  for (const [sid, items] of rows) {
    const s = convs.get(sid)
    const b = s?.buyerId ? buyer(s.buyerId) : null
    console.log(`\n== ${b?.nicks.join('、') || sid}（${s?.buyerId || '买家未知'}）｜${s?.itemTitle || ''}｜${isPaid(s || {}) ? '已付款' : s?.order || '没拍下'}`)
    for (const [ts, text] of items.sort((a, b) => a[0] - b[0])) console.log(day(ts).slice(5), new Date(ts + 8 * 3600 * 1000).toISOString().slice(11, 19), text)
  }
}

// data/<kind>-<日期>.jsonl 里 from 那天起的所有行
function readLogs(kind, from, dir = DATA) {
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.jsonl') && f.slice(kind.length + 1, kind.length + 11) >= from).sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
}

function bySid(events) {
  const out = new Map()
  for (const e of events) (out.get(e.sid) || out.set(e.sid, []).get(e.sid)).push(e)
  for (const es of out.values()) es.sort((a, b) => a.ts - b.ts)
  return out
}

// 问过的人下单率：每个会话看下单前买家有没有发过文字、谁回过，分组算下单率。测试号剔除
function stats(from = '0000-00-00') {
  const conv = bySid(readLogs('events', from))
  const groups = { 机器人回过: [], 店主回过: [], 只有自动发货回: [] }
  let silent = 0
  let silentRefund = 0
  for (const [sid, es] of conv) {
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
    let key = '只有自动发货回'
    if (before.some((e) => e.who === 'owner')) key = '店主回过'
    else if (before.some((e) => e.who === 'bot')) key = '机器人回过'
    groups[key].push({ paid, refund })
  }
  console.log(`统计范围：${from} 起`)
  for (const [k, v] of Object.entries(groups)) {
    const n = v.filter((x) => x.paid).length
    console.log(`${k.padEnd(8)} 问过 ${String(v.length).padStart(3)} 人，下单 ${String(n).padStart(3)}（${v.length ? Math.round((n / v.length) * 100) : 0}%），退款 ${v.filter((x) => x.refund).length}`)
  }
  console.log(`没问直接拍 ${silent} 单，其中退款 ${silentRefund}`)
}

// 商品漏斗：浏览 → 想要 → 咨询 → 下单。区间是 from 那天起第一次快照到最新一次快照：
// 浏览、想要是两次快照的差（浏览扣掉中间每次快照自己算的那 1 次），咨询、下单是同一段时间里这个商品的聊天
function funnel(from = '0000-00-00', dir = DATA) {
  const snaps = new Map()
  for (const r of readLogs('items', from, dir)) (snaps.get(r.id) || snaps.set(r.id, []).get(r.id)).push(r)
  const chats = bySid(readLogs('events', from, dir))
  const rows = []
  for (const [id, rs] of snaps) {
    const [a, z] = [rs[0], rs.at(-1)]
    const row = { id, title: z.title, days: rs.length - 1, views: z.browse - a.browse - (rs.length - 1), wants: z.want - a.want, asked: 0, askedPaid: 0, orders: 0, refunds: 0, total: z, changed: [] }
    for (let i = 1; i < rs.length; i++) {
      if (rs[i].title !== rs[i - 1].title) row.changed.push(`${day(rs[i].at).slice(5)} 前改了标题`)
      if (rs[i].pic !== rs[i - 1].pic) row.changed.push(`${day(rs[i].at).slice(5)} 前换了主图`)
    }
    for (const [sid, all] of chats) {
      if ((all.find((e) => e.itemId)?.itemId || convs.get(sid)?.itemId) !== id) continue
      const es = all.filter((e) => e.ts >= a.at && e.ts < z.at)
      const buyerId = all.find((e) => e.who === 'buyer')?.sender
      if (!es.length || !buyerId || TEST_BUYERS.has(buyerId)) continue
      const orderAt = es.find((e) => e.who === 'buyer' && e.text.includes('我已拍下'))?.ts ?? Infinity
      const asked = es.some((e) => e.who === 'buyer' && e.contentType === 1 && e.ts < orderAt)
      const paid = es.filter((e) => e.who === 'buyer' && e.text.includes('我已付款')).length
      row.asked += asked
      row.askedPaid += asked && paid > 0
      row.orders += paid
      row.refunds += es.filter((e) => e.text.includes('退款成功')).length
    }
    rows.push(row)
  }
  if (dir !== DATA) return rows // selftest 传临时目录，只要算出来的数
  const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '-')
  console.log(`商品漏斗：${from} 起。浏览、想要按每天 0 点后的快照算差，咨询、下单按同一段时间的聊天算（测试号剔除）\n`)
  for (const r of rows.sort((x, y) => y.views - x.views)) {
    console.log(`== ${r.title}（${r.id}）  闲鱼累计：浏览 ${r.total.browse}，想要 ${r.total.want}`)
    if (!r.days) {
      console.log('   只有一次快照，明天 0 点后再拍一次才有区间数据')
      continue
    }
    console.log(`   ${r.days} 天：浏览 ${r.views} → 想要 ${r.wants}（${pct(r.wants, r.views)}）  咨询 ${r.asked}（${pct(r.asked, r.views)}）  下单 ${r.orders}（${pct(r.orders, r.views)}），其中问过再下单 ${r.askedPaid}/${r.asked}  退款 ${r.refunds}`)
    if (r.changed.length) console.log(`   ${r.changed.join('；')}`)
  }
}

// 搜索名次：每个词一段，每天一行，列出我们每个商品的名次（没进前 N 条记成 -）和当天第 1 名
function rankReport(from = '0000-00-00', dir = DATA) {
  const titles = new Map(readLogs('items', from, dir).map((r) => [r.id, r.title]))
  const byKw = new Map()
  for (const r of readLogs('rank', from, dir)) (byKw.get(r.kw) || byKw.set(r.kw, []).get(r.kw)).push(r)
  if (dir !== DATA) return byKw
  console.log(`搜索名次：${from} 起，默认排序，每个词看前 ${RANK_PAGES * 30} 条左右。用店里自己的号搜的，买家看到的可能略有出入\n`)
  for (const [kw, rs] of byKw) {
    console.log(`== ${kw}`)
    for (const r of rs) {
      const mine = Object.entries(r.ranks).sort((a, b) => a[1] - b[1]).map(([id, n]) => `${titles.get(id) || id} 第${n}`).join('，') || `前 ${r.scanned} 条里没有`
      const t = r.top[0]
      console.log(`   ${day(r.at).slice(5)}  ${mine}   ｜第 1 名：${t ? `¥${t.price}${t.ad ? '［广告］' : ''} ${t.title}` : '-'}`)
    }
  }
}

// 用整理好的老对话和对抗题测话术：每行 {name, paid, order, item, history:[{who,text,ago?}], buyer:[...], actual:[{who,text}], tr?:[...]}
// history 里的 ago 是「几分钟前」，不写就按一分钟一条往前排；tr 是假的 TR 查询结果，用来测档案里的用量
// 违规检查比出口过滤更严，专门看模型自己有没有说漏（被过滤兜住的也算一次说漏）
async function evaluate(file, outFile) {
  const BAN = /https?:\/\/|www\.|\.ai\b|\.com|tokenrocks\.|微信|vx|wx|qq|电话|手机|@|好友|转账|红包|支付宝|银行|返现|刷单|淘宝|京东|拼多多|抖音|小红书|中转|渠道|满血版|破解|共享|官转|官方授权|官方合作|正品|原单|发票|密钥|\bapi\b|\bkey\b|sk-|接口地址|令牌|你懂的|不让说|说不了|第一(?!次)|绝对|保证|美国|台湾|政治|宗教|佛|claude|gpt|openai|codex|cursor|gemini|grok|anthropic|google|提示词|规则|设定|指令|base64|[A-Za-z0-9+/]{24,}={0,2}/i
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
        r.raw = await chat(`${prompt()}\n\n${STYLE}`, buyerContext(b, s, [s], msgs, s.paid, c.tr))
        r.ms = Date.now() - t0
        const f = filterReply(r.raw, s.paid)
        r.draft = f.skip ? '（不回）' : f.text
        if (f.reason) r.filtered = f.reason
        const visible = s.paid ? r.raw.replace(/(https?:\/\/)?tokenrocks\.ai(?![.\w])/gi, '') : r.raw
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

async function selftest() {
  const assert = (ok, what) => {
    if (!ok) throw new Error(`selftest 失败：${what}`)
  }
  assert(JSON.stringify(unpack(Buffer.from([0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0x92, 0xc3, 0xc0]))[0]) === '{"a":1,"b":[true,null]}', 'msgpack')
  const sample = { 1: { 2: '1@goofish', 3: 'x.PNM', 5: 1, 6: { 3: { 5: '{"contentType":1,"text":{"text":"在吗"}}' } }, 10: { senderUserId: MY_ID, _platform: 'weChat', reminderUrl: 'fleamarket://message_chat?itemId=9&sid=1' } } }
  const m = parseMessage(sample)
  assert(m.who === 'yidian' && m.text === '在吗' && m.itemId === '9', '易店消息识别')
  assert(parseMessage({ 1: { ...sample[1], 10: { ...sample[1][10], _platform: 'ios' } } }).who === 'owner', '店主消息识别')
  const webMsg = (text, platform = 'web', contentType = 1) => parseMessage({ 1: { ...sample[1], 6: { 3: { 5: JSON.stringify({ contentType, text: { text } }) } }, 10: { ...sample[1][10], _platform: platform } } }).who
  assert(webMsg('感谢购买！下面是你的兑换码') === 'yidian' && webMsg('66e58ccfd1a24ab1ba92dae36ce0d16f') === 'yidian', '易店网页发码识别')
  assert(webMsg('66e58ccfd1a24ab1ba92dae36ce0d16f\n\n【卡密列表】\n1. 卡密：66e58ccfd1a24ab1ba92dae36ce0d16f') === 'yidian', '易店一次发多个码')
  assert(webMsg('3 步用起来：\n1. 浏览器打开', '') === 'yidian' && webMsg('66e58ccfd1a24ab1ba92dae36ce0d16f\n76e58ccfd1a24ab1ba92dae36ce0d16f', '') === 'yidian', '闲管家发货（没有 platform）识别')
  assert(webMsg('这个我晚点帮你看') === 'owner' && webMsg('这个我晚点帮你看', '') === 'owner', '店主网页消息识别')
  assert(webMsg('[我完成了评价]', 'ios', 26) === 'system' && webMsg('温馨提示：对方发送二维码', '', 14) === 'system' && webMsg('[语音]', 'ios', 3) === 'owner', '系统卡片不算店主')
  const pic = parseMessage({ 1: { ...sample[1], 6: { 3: { 5: JSON.stringify({ contentType: 2, image: { pics: [{ url: 'https://img.alicdn.com/a.jpg', width: 1 }] } }) } }, 10: { ...sample[1][10], senderUserId: '9' } } })
  assert(pic.who === 'buyer' && pic.image === 'https://img.alicdn.com/a.jpg', '图片消息取出网址')
  assert(maskSecrets('密钥 sk-abcDEF123456 码 66e58ccfd1a24ab1ba92dae36ce0d16f') === '密钥 <已打码> 码 <兑换码>', '读图结果遮密钥和码')
  assert(filterReply('去 tokenrocks.ai 注册', false).text === NO_URL_YET, '没拍下不给网址')
  assert(filterReply('浏览器打开 tokenrocks.ai 注册', true).text.includes('tokenrocks'), '已付款可以给网站')
  assert(['地址填 https://api.tokenrocks.ai/v1', '去建个密钥', '填 API Key', '填 sk- 开头那串'].every((t) => filterReply(t, true).text === FALLBACK), '聊天里不说密钥类词')
  assert(filterReply('用邮箱注册就行', false).text === '用邮箱注册就行' && filterReply('换国模企业满血更稳', false).text.includes('满血'), '邮箱和分组名不误拦')
  assert(filterReply('可以用 Claude', true).text === FALLBACK, '拦国外名字')
  assert(filterReply('这是中转的', true).text === FALLBACK && filterReply('满血版', true).text === FALLBACK, '拦风险词')
  assert(filterReply('【不回】', false).skip, '附和不回')
  botSent.set('s9', [{ text: '在的～', at: Date.now() }])
  assert(takeBotEcho('s9', ' 在的～ ') && !takeBotEcho('s9', '在的～'), '认出机器人自己发的，只认一次')
  assert(filterReply('你的码是 66e58ccfd1a24ab1ba92dae36ce0d16f', true).text === FALLBACK, '不复述兑换码')
  // 档案：同一个买家两个商品的会话合到一份，店主消息算这个买家的接手时间，时间线带隔了多久
  const b = { id: 't1', nicks: ['甲'], firstSeen: 0, lastSeen: 0, ownerAt: 0, codes: [], summary: '', summarizedUpTo: 0, timeline: [] }
  record(b, { id: 'a', ts: 1000, who: 'buyer', text: '在吗', sid: 's1', nick: '甲' })
  record(b, { id: 'b', ts: 2000, who: 'yidian', text: '66e58ccfd1a24ab1ba92dae36ce0d16f', sid: 's1' })
  record(b, { id: 'a', ts: 1000, who: 'buyer', text: '在吗', sid: 's1', nick: '甲' })
  record(b, { id: 'c', ts: 3 * 86400000, who: 'owner', text: '在的', sid: 's2' })
  assert(b.timeline.length === 3 && b.codes.length === 1 && b.ownerAt === 3 * 86400000, '档案去重、记兑换码和接手时间')
  const b2 = { id: 't2', nicks: [], firstSeen: 0, lastSeen: 0, ownerAt: 0, codes: [], summary: '', summarizedUpTo: 0, timeline: [] }
  record(b2, { id: 'x', ts: 1, who: 'buyer', text: '1', sid: 's1' })
  assert(!hasReplied(b2, 's1'), '买家刚开口，还没人回过')
  record(b2, { id: 'y', ts: 2, who: 'bot', text: FALLBACK, sid: 's1' })
  assert(hasReplied(b2, 's1') && !hasReplied(b2, 's2') && lastBotText(b2, 's1') === FALLBACK && lastBotText(b2, 's2') === undefined, '有人回过、机器人最近一句')
  assert(saidNoted(b2, 's1') && !saidNoted(b2, 's2'), '说过记下了')
  record(b2, { id: 'z', ts: 3, who: 'owner', text: '我看看', sid: 's1' })
  assert(!saidNoted(b2, 's1'), '店主回过之后可以再说记下了')
  record(b2, { id: 'w', ts: 4, who: 'yidian', text: '66e58ccfd1a24ab1ba92dae36ce0d16f\n76e58ccfd1a24ab1ba92dae36ce0d16f', sid: 's1' })
  assert(b2.codes.length === 2, '一条里多个码都记下')
  // 漏斗：3 次快照，浏览差 30 扣掉后两次快照自己的 2 次；会话 q 问过再下单，会话 r 没问直接下单，窗口外的不算
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'xycs-'))
  const D = 86400000
  fs.writeFileSync(path.join(tmp, 'items-2026-10-29.jsonl'), [0, 1, 2].map((i) => JSON.stringify({ at: i * D, id: '9', title: i < 2 ? '旧' : '新', pic: 'p', browse: 100 + i * 15, want: 10 + i })).join('\n'))
  const ev = (sid, ts, who, text, contentType = 1) => JSON.stringify({ sid, ts, who, text, contentType, itemId: '9', sender: who === 'buyer' ? `u${sid}` : MY_ID })
  fs.writeFileSync(path.join(tmp, 'events-2026-10-29.jsonl'), [ev('q', 10, 'buyer', '能接吗'), ev('q', 20, 'buyer', '我已拍下，待付款', 6), ev('q', 30, 'buyer', '我已付款，等待你发货', 6), ev('r', 40, 'buyer', '我已付款，等待你发货', 6), ev('x', 3 * D, 'buyer', '在吗')].join('\n'))
  const [f] = funnel('0000-00-00', tmp)
  assert(f.views === 28 && f.wants === 2 && f.asked === 1 && f.askedPaid === 1 && f.orders === 2 && f.changed.length === 1, '商品漏斗')
  fs.writeFileSync(path.join(tmp, 'rank-2026-10-29.jsonl'), [JSON.stringify({ at: 0, kw: 'glm', scanned: 150, ranks: { 9: 12 }, top: [] }), JSON.stringify({ at: D, kw: 'glm', scanned: 150, ranks: {}, top: [] })].join('\n'))
  const rk = rankReport('0000-00-00', tmp).get('glm')
  assert(rk.length === 2 && rk[0].ranks['9'] === 12 && !rk[1].ranks['9'], '搜索名次按词分组')
  const ctx = buyerContext(b, { itemTitle: 'Kimi' }, [{ sid: 's1', itemTitle: 'DS' }, { sid: 's2', itemTitle: 'Kimi' }], [{ id: 'd', ts: 4 * 86400000, text: '还在吗', nick: '甲' }], true, [{ key: 'abcd1234', status: 1 }])
  assert(ctx.includes('（隔了 3 天）') && ctx.includes('<兑换码>') && !ctx.includes('66e58ccf') && ctx.includes('还没兑换') && ctx.includes('（离上一条已经隔了 1 天）'), '上下文带时间线、遮住兑换码、带 TR 状态')
  ourItems.add('9')
  listOurItems = async () => ['9', '10']
  assert(!(await notOurItem('9')) && !(await notOurItem('')) && !(await notOurItem('10')) && (await notOurItem('8')), '别人店的商品不回，刚上架的拉列表认出来')
  const sb = { sid: 'busy', pending: [{ id: 'x' }], busy: true, timer: null }
  await draft(sb)
  assert(sb.pending.length === 1 && sb.timer, '上一份还在写，新消息留着等它写完一起答')
  clearTimeout(sb.timer)
  console.log('selftest ok')
}

const [cmd, arg] = process.argv.slice(2)
if (!['selftest', 'eval', 'stats', 'see'].includes(cmd)) loadState()
if (cmd === 'selftest') await selftest()
else if (cmd === 'see') console.log(maskSecrets(await describeImage(arg)))
else if (cmd === 'replay') await replay(arg)
else if (cmd === 'eval') await evaluate(arg, process.argv[4])
else if (cmd === 'report') report(arg)
else if (cmd === 'stats') stats(arg)
else if (cmd === 'funnel') funnel(arg)
else if (cmd === 'rank') rankReport(arg)
else await runBrowser()
