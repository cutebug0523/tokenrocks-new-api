// 模型与价格页：读站点公开的 /api/pricing，按线路渲染价格。
// 价格口径和控制台模型广场一致：官方价（美元/百万 token）× 7 = 人民币官方价，
// 再乘分组倍率（模型级覆盖倍率优先）得到本站价格。
;(function () {
  'use strict'

  var USD_TO_CNY = 7
  var TIERS = {
    value: { label: '特价线路', match: '特价', note: '价格最低，个别上游附带固定提示词' },
    enterprise: { label: '企业满血线路', match: '满血', note: '官方原版模型，稳定优先' }
  }
  var VENDOR_ORDER = ['Anthropic', 'OpenAI', 'DeepSeek', '阿里巴巴', 'Google']
  var ALL = '全部'

  var state = { tier: 'value', vendor: ALL, query: '' }
  var pricing = null
  var textModels = []
  var imageModels = []

  var params = new URLSearchParams(window.location.search)
  if (/满血/.test(params.get('group') || '')) state.tier = 'enterprise'
  if (params.get('search')) state.query = params.get('search')

  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k]
      else if (k === 'class') node.className = attrs[k]
      else node.setAttribute(k, attrs[k])
    })
    ;(children || []).forEach(function (c) {
      if (c) node.appendChild(c)
    })
    return node
  }

  function yuan(n) {
    return '¥' + String(Math.round(n * 10000) / 10000)
  }

  function discountLabel(ratio) {
    return String(Math.round(ratio * 100) / 10) + '折'
  }

  // 模型级覆盖倍率优先，没有就用分组倍率
  function ratioFor(modelName, group) {
    var override = pricing.model_group_ratio && pricing.model_group_ratio[modelName]
    if (override && override[group] != null) return override[group]
    return pricing.group_ratio[group]
  }

  function groupForTier(model, tier) {
    var groups = model.enable_groups || []
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].indexOf(TIERS[tier].match) >= 0) return groups[i]
    }
    return null
  }

  // 官方价，美元 / 百万 token。表达式计费的模型取第一档（标准上下文）的 p、c 系数。
  function officialTokenPrice(model) {
    if (model.billing_mode === 'tiered_expr' && model.billing_expr) {
      var p = /\bp\s*\*\s*([\d.]+)/.exec(model.billing_expr)
      var c = /\bc\s*\*\s*([\d.]+)/.exec(model.billing_expr)
      if (!p || !c) return null
      return { input: Number(p[1]), output: Number(c[1]) }
    }
    return { input: model.model_ratio * 2, output: model.model_ratio * 2 * model.completion_ratio }
  }

  // 按张计费的单价（美元），不是按张计费返回 null
  function officialImagePrice(model) {
    if (model.billing_expr) {
      var f = /fixed\(\s*([\d.]+)\s*\)/.exec(model.billing_expr)
      return f ? Number(f[1]) : null
    }
    if (model.quota_type === 1) return model.model_price
    return null
  }

  function vendorName(model) {
    var vendors = pricing.vendors || []
    for (var i = 0; i < vendors.length; i++) {
      if (vendors[i].id === model.vendor_id) return vendors[i].name
    }
    return '其他'
  }

  function vendorRank(name) {
    var i = VENDOR_ORDER.indexOf(name)
    return i < 0 ? VENDOR_ORDER.length : i
  }

  function prepare() {
    var data = pricing.data || []
    data.forEach(function (m) {
      var item = { name: m.model_name, desc: m.description || '', vendor: vendorName(m), raw: m }
      if ((m.enable_groups || []).indexOf('生图') >= 0) {
        item.perImage = officialImagePrice(m)
        imageModels.push(item)
        return
      }
      item.official = officialTokenPrice(m)
      if (item.official) textModels.push(item)
    })
    textModels.sort(function (a, b) {
      return vendorRank(a.vendor) - vendorRank(b.vendor) || b.official.input - a.official.input || a.name.localeCompare(b.name)
    })
    imageModels.sort(function (a, b) {
      return vendorRank(a.vendor) - vendorRank(b.vendor) || a.name.localeCompare(b.name)
    })
    document.querySelectorAll('[data-model-count]').forEach(function (n) {
      n.textContent = String(data.length)
    })
  }

  function renderVendors() {
    var names = [ALL]
    textModels.forEach(function (m) {
      if (names.indexOf(m.vendor) < 0) names.push(m.vendor)
    })
    var box = document.getElementById('vendor-chips')
    box.textContent = ''
    names.forEach(function (name) {
      var b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(name === state.vendor), text: name })
      b.addEventListener('click', function () {
        state.vendor = name
        render()
      })
      box.appendChild(b)
    })
  }

  function priceCell(official, ratio) {
    var cny = official * USD_TO_CNY
    if (ratio == null) return el('td', {}, [el('div', { class: 'num', text: '—' }), el('s', { class: 'official', text: yuan(cny) })])
    return el('td', {}, [el('div', { class: 'num', text: yuan(cny * ratio) }), el('s', { class: 'official', text: yuan(cny) })])
  }

  function renderText() {
    var tier = state.tier
    var q = state.query.trim().toLowerCase()
    var rows = textModels.filter(function (m) {
      if (state.vendor !== ALL && m.vendor !== state.vendor) return false
      if (q && m.name.toLowerCase().indexOf(q) < 0 && m.desc.toLowerCase().indexOf(q) < 0) return false
      return true
    })
    var body = document.getElementById('text-rows')
    body.textContent = ''
    if (!rows.length) {
      body.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'status', text: '没有符合条件的模型' })]))
      return
    }
    rows.forEach(function (m) {
      var group = groupForTier(m.raw, tier)
      var ratio = group ? ratioFor(m.name, group) : null
      var badge = el('span', { class: 'badge', text: ratio == null ? '' : discountLabel(ratio), title: group || '' })
      if (ratio == null) {
        var otherTier = tier === 'value' ? 'enterprise' : 'value'
        badge.className = 'badge off'
        badge.textContent = groupForTier(m.raw, otherTier) ? '仅' + TIERS[otherTier].label.replace('线路', '') : '暂不可用'
      }
      body.appendChild(
        el('tr', {}, [
          el('td', {}, [
            el('a', { class: 'model-name', href: '/pricing/' + encodeURIComponent(m.name), text: m.name }),
            m.desc ? el('div', { class: 'model-desc', text: m.desc }) : null
          ]),
          el('td', { class: 'col-vendor', style: 'color: #374151; white-space: nowrap;', text: m.vendor }),
          priceCell(m.official.input, ratio),
          priceCell(m.official.output, ratio),
          el('td', {}, [badge])
        ])
      )
    })
  }

  function renderImages() {
    var box = document.getElementById('image-cards')
    box.textContent = ''
    imageModels.forEach(function (m) {
      var ratio = ratioFor(m.name, '生图')
      var price = m.perImage == null || ratio == null
        ? el('span', { style: 'font-size: 14px; color: #4B5563;', text: '按用量计费，点模型名看详情' })
        : el('span', { class: 'num', style: 'font-size: 20px;', text: yuan(m.perImage * USD_TO_CNY * ratio) + ' / 张' })
      box.appendChild(
        el('div', { class: 'img-card' }, [
          el('a', { class: 'model-name', href: '/pricing/' + encodeURIComponent(m.name), text: m.name }),
          m.desc ? el('span', { style: 'font-size: 14px; color: #4B5563;', text: m.desc }) : null,
          price
        ])
      )
    })
  }

  function render() {
    document.querySelectorAll('.tier-btn').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-tier') === state.tier))
    })
    document.getElementById('tier-name').textContent = TIERS[state.tier].label
    document.getElementById('tier-note').textContent = TIERS[state.tier].note
    renderVendors()
    renderText()
  }

  document.querySelectorAll('.tier-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      state.tier = b.getAttribute('data-tier')
      render()
    })
  })
  var search = document.getElementById('model-search')
  search.value = state.query
  search.addEventListener('input', function () {
    state.query = search.value
    renderText()
  })

  fetch('/api/pricing', { credentials: 'same-origin' })
    .then(function (r) {
      if (!r.ok) throw new Error(String(r.status))
      return r.json()
    })
    .then(function (j) {
      if (!j || !j.success || !Array.isArray(j.data)) throw new Error('bad payload')
      pricing = j
      prepare()
      render()
      renderImages()
    })
    .catch(function () {
      var body = document.getElementById('text-rows')
      body.textContent = ''
      body.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'status', text: '价格暂时没加载出来，请刷新重试' })]))
    })
})()
