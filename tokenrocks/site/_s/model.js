// 模型详情页：/pricing/<模型名> 都由 nginx 指到这个页面，按网址里的模型名读
// /api/pricing（价格）和 /_s/tests/models/<模型名>.json（每周实测结果）。
;(function () {
  'use strict'

  var TR = window.TR
  var el = TR.el
  var name = decodeURIComponent(window.location.pathname.replace(/^\/pricing\//, '').replace(/\/+$/, ''))
  var pricing = null
  var model = null
  var vendor = ''

  var CHECKS = [
    { id: 'input_tokens', name: '输入 token 计数', how: '发原版鹈鹕提示词，看上游计了多少输入 token。两条线路差得多，说明有一边被加了内容，或者用量是估算的。' },
    { id: 'max_tokens', name: 'max_tokens 是否生效', how: '要求最多回 16 个 token，看会不会马上停下。无视上限的上游会先跑完再截断，要等很久。' },
    { id: 'session', name: '会话是否串联', how: '先让它记住一个暗号，再新开一次请求问暗号。正常的接口没有记忆，只会答不知道。' },
    { id: 'format', name: '输出是否合规', how: '要 SVG 就只给 SVG：不夹带整页 HTML、外部链接或提示词里没有的内容。' },
    { id: 'pelican', name: '鹈鹕作图', how: '耗时和输出 token，作品见下方。' }
  ]
  var KIND_LABEL = { svg: '静态 SVG', html: 'HTML + 脚本', none: '没有交回作品' }

  document.title = name + ' · TokenRocks'
  document.getElementById('crumb-name').textContent = name
  document.getElementById('model-name').textContent = name
  document.getElementById('pelican-prompt').textContent = TR.PELICAN_PROMPT

  function apiFormat() {
    return vendor === 'Anthropic' ? 'anthropic' : 'openai'
  }

  // ---------- 价格 ----------
  function priceBlock(label, official, ratio) {
    var cny = official * TR.USD_TO_CNY
    return el('div', {}, [
      el('div', { class: 'price-label', text: label }),
      el('span', { class: 'price-big', text: TR.yuan(cny * ratio) }),
      document.createTextNode(' '),
      el('s', { class: 'official', text: TR.yuan(cny) })
    ])
  }

  function renderPrices() {
    var cards = document.getElementById('price-cards')
    var table = document.getElementById('price-table')
    cards.textContent = ''
    table.textContent = ''

    if (TR.isImageModel(model)) {
      var perImage = TR.officialImagePrice(model)
      var ratio = TR.ratioFor(pricing, name, '生图')
      var text = perImage == null || ratio == null ? '按用量计费' : TR.yuan(perImage * TR.USD_TO_CNY * ratio) + ' / 张'
      cards.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('span', { text: '生图 · 按张计费' })]),
        el('span', { class: 'price-big', text: text }),
        el('span', { class: 'card-note', text: '生图分组，一口价。' })
      ]))
      table.appendChild(el('tbody', {}, [el('tr', {}, [el('td', { text: '生图' }), el('td', { class: 'price-big', style: 'font-size: 16px;', text: text })])]))
      return
    }

    var official = TR.officialTokenPrice(model)
    if (!official) return
    // 每列：表头、官方价（美元 / 百万 token）；缓存价没有就不列
    var cache = TR.officialCachePrice(model)
    var cols = [['输入', official.input], ['输出', official.output]]
    if (cache.read != null) cols.push(['缓存命中', cache.read])
    if (cache.write != null) cols.push(['缓存写入', cache.write])
    var rows = [['官方价', 1, '—']]
    ;['value', 'enterprise'].forEach(function (tier) {
      var group = TR.groupForTier(model, tier)
      if (!group) return
      var ratio = TR.ratioFor(pricing, name, group)
      cards.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('span', { text: TR.TIERS[tier].label }), el('span', { class: 'badge', text: TR.discountLabel(ratio), title: group })]),
        el('div', { class: 'price-pair' }, cols.map(function (c) { return priceBlock(c[0] + ' / 百万 token', c[1], ratio) })),
        el('span', { class: 'card-note', text: TR.TIERS[tier].note + '。分组：' + group })
      ]))
      rows.push([TR.TIERS[tier].label, ratio, TR.discountLabel(ratio)])
    })
    var heads = ['线路'].concat(cols.map(function (c) { return c[0] + ' / 百万 token' }), ['折扣'])
    table.appendChild(el('thead', {}, [el('tr', {}, heads.map(function (h) { return el('th', { scope: 'col', text: h }) }))]))
    table.appendChild(el('tbody', {}, rows.map(function (r) {
      return el('tr', {}, [el('td', { text: r[0] })].concat(
        cols.map(function (c) { return el('td', { class: 'price-big', style: 'font-size: 15px;', text: TR.yuan(c[1] * TR.USD_TO_CNY * r[1]) }) }),
        [el('td', { text: r[2] })]
      ))
    })))
  }

  // ---------- 接入示例 ----------
  function codeBlock(title, code) {
    var pre = el('pre', { class: 'code', text: code })
    var btn = el('button', { type: 'button', class: 'btn-outline', style: 'height: 30px; padding: 0 10px; font-size: 12px;', text: '复制' })
    btn.addEventListener('click', function () {
      if (!navigator.clipboard) return
      navigator.clipboard.writeText(code).then(function () {
        btn.textContent = '已复制'
        setTimeout(function () { btn.textContent = '复制' }, 1500)
      })
    })
    return el('div', {}, [
      el('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' }, [el('span', { style: 'font-weight: 600;', text: title }), btn]),
      pre
    ])
  }

  function renderCode() {
    var box = document.getElementById('code-blocks')
    var intro = document.getElementById('code-intro')
    box.textContent = ''
    if (TR.isImageModel(model)) {
      intro.textContent = 'OpenAI 兼容的图片接口，把密钥换成你在控制台创建的那把（分组用生图或 auto）。'
      box.appendChild(codeBlock('cURL', 'curl https://api.tokenrocks.ai/v1/images/generations \\\n  -H "Authorization: Bearer sk-你的密钥" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model": "' + name + '", "prompt": "一只骑自行车的鹈鹕", "size": "1024x1024"}\''))
      return
    }
    if (apiFormat() === 'anthropic') {
      intro.textContent = 'Anthropic 原生接口和 OpenAI 兼容接口都能用，把密钥换成你在控制台创建的那把。'
      box.appendChild(codeBlock('cURL · Anthropic 原生', 'curl https://api.tokenrocks.ai/v1/messages \\\n  -H "x-api-key: sk-你的密钥" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "content-type: application/json" \\\n  -d \'{"model": "' + name + '", "max_tokens": 1024,\n       "messages": [{"role": "user", "content": "你好"}]}\''))
      box.appendChild(codeBlock('Claude Code', 'export ANTHROPIC_BASE_URL=https://api.tokenrocks.ai\nexport ANTHROPIC_AUTH_TOKEN=sk-你的密钥\nexport ANTHROPIC_MODEL=' + name + '\nclaude'))
      return
    }
    intro.textContent = 'OpenAI 兼容接口，把密钥换成你在控制台创建的那把。'
    box.appendChild(codeBlock('cURL', 'curl https://api.tokenrocks.ai/v1/chat/completions \\\n  -H "Authorization: Bearer sk-你的密钥" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model": "' + name + '", "messages": [{"role": "user", "content": "你好"}]}\''))
    box.appendChild(codeBlock('Python', 'from openai import OpenAI\n\nclient = OpenAI(base_url="https://api.tokenrocks.ai/v1", api_key="sk-你的密钥")\nreply = client.chat.completions.create(\n    model="' + name + '",\n    messages=[{"role": "user", "content": "你好"}],\n)\nprint(reply.choices[0].message.content)'))
  }

  // ---------- 实测 ----------
  function resultChip(check) {
    if (!check) return el('span', { class: 'res todo', text: '待测' })
    return el('span', { class: 'res ' + (check.status || 'info'), text: check.text || '—' })
  }

  function renderTests(report) {
    var meta = document.getElementById('test-meta')
    var rows = document.getElementById('test-rows')
    var gallery = document.getElementById('gallery')
    var rawBox = document.getElementById('raw-box')
    rows.textContent = ''
    gallery.textContent = ''
    rawBox.textContent = ''

    if (TR.isImageModel(model)) {
      meta.textContent = '图片模型暂不做实测。'
      rows.appendChild(el('tr', {}, [el('td', { colspan: '3', class: 'status', text: '图片模型暂不做实测' })]))
      document.getElementById('retest-form').hidden = true
      return
    }
    var lines = (report && report.lines) || {}
    if (!report) {
      meta.textContent = '这个模型还没有实测数据。平台每周一自动实测旗舰模型；也可以用下面的表单，拿你自己的密钥测。'
    } else {
      var when = new Date(report.ran_at)
      meta.textContent = '最近一次 ' + when.toLocaleString('zh-CN', { hour12: false }) + ' · 平台每周一自动跑一次 · 每项的原始数据可以在下方展开'
    }

    CHECKS.forEach(function (c) {
      rows.appendChild(el('tr', {}, [
        el('td', {}, [el('div', { class: 'check-name', text: c.name }), el('div', { class: 'check-how', text: c.how })]),
        el('td', {}, [TR.groupForTier(model, 'value') ? resultChip(lines.value && lines.value.checks[c.id]) : el('span', { class: 'res todo', text: '不提供' })]),
        el('td', {}, [TR.groupForTier(model, 'enterprise') ? resultChip(lines.enterprise && lines.enterprise.checks[c.id]) : el('span', { class: 'res todo', text: '不提供' })])
      ]))
    })

    ;['value', 'enterprise'].forEach(function (tier) {
      if (!TR.groupForTier(model, tier)) return
      var line = lines[tier]
      var pelican = line && line.checks.pelican
      var pic = el('div', { class: 'empty', text: report ? '没有交回作品' : '待测' })
      if (pelican && pelican.file) {
        // 作品原样展示：SVG 和 HTML 都放进不带同源权限的沙箱，脚本能跑动画，读不到本站数据
        pic = el('iframe', { src: '/_s/tests/' + pelican.file, sandbox: 'allow-scripts', loading: 'lazy', title: TR.TIERS[tier].label + '画的鹈鹕骑自行车', referrerpolicy: 'no-referrer' })
      }
      var caption = el('figcaption', {}, [el('b', { text: TR.TIERS[tier].label })])
      if (pelican) caption.appendChild(document.createTextNode(' · ' + (KIND_LABEL[pelican.kind] || '') + (pelican.text ? ' · ' + pelican.text : '')))
      gallery.appendChild(el('figure', { class: 'art' }, [pic, caption]))

      if (line) {
        var raw = {}
        CHECKS.forEach(function (c) { if (line.checks[c.id]) raw[c.id] = line.checks[c.id].detail || {} })
        rawBox.appendChild(el('details', { class: 'raw', style: 'margin-bottom: 10px;' }, [
          el('summary', { text: '原始数据 · ' + TR.TIERS[tier].label + '（分组 ' + line.group + '）' }),
          el('pre', { class: 'code', text: JSON.stringify(raw, null, 2) })
        ]))
      }
    })
  }

  // ---------- 用自己的密钥复测（在浏览器里直接请求本站接口） ----------
  function request(key, body) {
    var anthropic = apiFormat() === 'anthropic'
    var headers = { 'content-type': 'application/json' }
    if (anthropic) {
      headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.Authorization = 'Bearer ' + key
    }
    return fetch(anthropic ? '/v1/messages' : '/v1/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(body) })
  }

  function buildBody(prompt, maxTokens, stream) {
    var body = { model: name, messages: [{ role: 'user', content: prompt }], stream: stream }
    if (apiFormat() === 'anthropic' || vendor !== 'OpenAI') body.max_tokens = maxTokens
    else body.max_completion_tokens = maxTokens
    return body
  }

  function replyText(json) {
    if (apiFormat() === 'anthropic') {
      return (json.content || []).filter(function (b) { return b.type === 'text' }).map(function (b) { return b.text }).join('')
    }
    return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || ''
  }

  function inputTokens(json) {
    var u = json.usage || {}
    return u.input_tokens != null ? u.input_tokens : u.prompt_tokens
  }

  async function readStreamEnd(res) {
    var reader = res.body.getReader()
    var dec = new TextDecoder()
    var buf = ''
    var stop = null
    for (;;) {
      var chunk = await reader.read()
      if (chunk.done) break
      buf += dec.decode(chunk.value, { stream: true })
      var i
      while ((i = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line.indexOf('data:') !== 0) continue
        var data = line.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          var d = JSON.parse(data)
          if (d.delta && d.delta.stop_reason) stop = d.delta.stop_reason
          if (d.choices && d.choices[0] && d.choices[0].finish_reason) stop = d.choices[0].finish_reason
        } catch (e) {}
      }
    }
    return stop
  }

  function addResult(box, label, chip, extra) {
    box.appendChild(el('div', { class: 'retest-row' }, [el('b', { text: label }), chip, extra ? el('span', { style: 'color: var(--muted);', text: extra }) : null]))
  }

  async function runRetest(key, box) {
    var res = await request(key, buildBody(TR.PELICAN_PROMPT, 16, false))
    var json = await res.json().catch(function () { return {} })
    if (!res.ok) {
      addResult(box, '请求失败', el('span', { class: 'res fail', text: String(res.status) }), (json.error && (json.error.message || json.error)) || '检查密钥是否正确、所在分组有没有这个模型')
      return
    }
    addResult(box, '输入 token 计数', el('span', { class: 'res info', text: String(inputTokens(json)) }), '和上方表格里平台测到的数字对比')

    var t0 = performance.now()
    var streamRes = await request(key, buildBody(TR.PELICAN_PROMPT, 16, true))
    var stop = streamRes.ok ? await readStreamEnd(streamRes) : null
    var secs = (performance.now() - t0) / 1000
    var honored = streamRes.ok && secs < 30
    addResult(box, 'max_tokens 是否生效', el('span', { class: 'res ' + (honored ? 'ok' : 'fail'), text: secs.toFixed(1) + ' 秒' + (honored ? '停下' : '才结束') }), 'stop_reason：' + (stop || '无'))

    var word = 'ZEBRA-' + Math.floor(1000 + Math.random() * 9000)
    await request(key, buildBody('Remember this code word for later: ' + word + '. Reply with just OK.', 300, false))
    var askRes = await request(key, buildBody('What code word did I ask you to remember earlier? If you have no record of one, reply exactly UNKNOWN.', 400, false))
    var askJson = await askRes.json().catch(function () { return {} })
    var leaked = replyText(askJson).indexOf(word) >= 0
    addResult(box, '会话是否串联', el('span', { class: 'res ' + (leaked ? 'fail' : 'ok'), text: leaked ? '记得暗号' : '答不知道' }), '模型回答：' + replyText(askJson).slice(0, 80))
  }

  function setupRetest() {
    var form = document.getElementById('retest-form')
    var btn = document.getElementById('retest-btn')
    var box = document.getElementById('retest-results')
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var key = document.getElementById('retest-key').value.trim()
      if (!key) return
      btn.disabled = true
      btn.textContent = '复测中…'
      box.textContent = ''
      runRetest(key, box)
        .catch(function () { addResult(box, '复测中断', el('span', { class: 'res fail', text: '网络错误' }), '稍后再试') })
        .then(function () {
          btn.disabled = false
          btn.textContent = '开始复测'
        })
    })
  }

  // ---------- 标签页 ----------
  function setupTabs() {
    var tabs = ['test', 'price', 'code']
    tabs.forEach(function (id) {
      document.getElementById('tab-' + id).addEventListener('click', function () {
        tabs.forEach(function (other) {
          document.getElementById('tab-' + other).setAttribute('aria-selected', String(other === id))
          document.getElementById('panel-' + other).hidden = other !== id
        })
      })
    })
  }

  document.getElementById('copy-name').addEventListener('click', function (e) {
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(name).then(function () {
      e.target.textContent = '已复制'
      setTimeout(function () { e.target.textContent = '复制模型名' }, 1500)
    })
  })
  setupTabs()
  setupRetest()

  TR.fetchPricing()
    .then(function (j) {
      pricing = j
      model = j.data.filter(function (m) { return m.model_name === name })[0]
      if (!model) {
        document.getElementById('model-desc').textContent = '没有找到这个模型，可能已经下架。'
        document.getElementById('test-meta').textContent = ''
        document.getElementById('test-rows').textContent = ''
        document.getElementById('retest-form').hidden = true
        return
      }
      vendor = TR.vendorName(pricing, model)
      var vendorChip = document.getElementById('model-vendor')
      vendorChip.textContent = vendor
      vendorChip.hidden = false
      document.getElementById('model-desc').textContent = model.description || ''
      renderPrices()
      renderCode()
      return fetch('/_s/tests/models/' + encodeURIComponent(name) + '.json', { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null })
        .catch(function () { return null })
        .then(renderTests)
    })
    .catch(function () {
      document.getElementById('model-desc').textContent = '价格暂时没加载出来，请刷新重试。'
    })
})()
