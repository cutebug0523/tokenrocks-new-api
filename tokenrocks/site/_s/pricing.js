// 模型与价格页：读站点公开的 /api/pricing，按线路渲染价格。价格算法见 prices.js。
;(function () {
  'use strict'

  var TR = window.TR
  var el = TR.el
  var ALL = '全部'

  var state = { tier: 'value', vendor: ALL, query: '' }
  var pricing = null
  var textModels = []
  var imageModels = []

  var params = new URLSearchParams(window.location.search)
  if (/满血/.test(params.get('group') || '')) state.tier = 'enterprise'
  if (params.get('search')) state.query = params.get('search')

  function detailHref(name) {
    return '/pricing/' + encodeURIComponent(name)
  }

  function prepare() {
    pricing.data.forEach(function (m) {
      var item = { name: m.model_name, desc: m.description || '', vendor: TR.vendorName(pricing, m), raw: m }
      if (TR.isImageModel(m)) {
        item.perImage = TR.officialImagePrice(m)
        imageModels.push(item)
        return
      }
      item.official = TR.officialTokenPrice(m)
      item.cache = TR.officialCachePrice(m)
      if (item.official) textModels.push(item)
    })
    textModels.sort(function (a, b) {
      return TR.vendorRank(a.vendor) - TR.vendorRank(b.vendor) || b.official.input - a.official.input || a.name.localeCompare(b.name)
    })
    imageModels.sort(function (a, b) {
      return TR.vendorRank(a.vendor) - TR.vendorRank(b.vendor) || a.name.localeCompare(b.name)
    })
    document.querySelectorAll('[data-model-count]').forEach(function (n) {
      n.textContent = String(pricing.data.length)
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
    if (official == null) return el('td', {}, [el('div', { class: 'num', text: '—' })])
    var cny = official * TR.USD_TO_CNY
    return el('td', {}, [
      el('div', { class: 'num', text: ratio == null ? '—' : TR.yuan(cny * ratio) }),
      el('s', { class: 'official', text: TR.yuan(cny) })
    ])
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
      body.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'status', text: '没有符合条件的模型' })]))
      return
    }
    rows.forEach(function (m) {
      var group = TR.groupForTier(m.raw, tier)
      var ratio = group ? TR.ratioFor(pricing, m.name, group) : null
      var badge = el('span', { class: 'badge', text: ratio == null ? '' : TR.discountLabel(ratio), title: group || '' })
      if (ratio == null) {
        var otherTier = tier === 'value' ? 'enterprise' : 'value'
        badge.className = 'badge off'
        badge.textContent = TR.groupForTier(m.raw, otherTier) ? '仅' + TR.TIERS[otherTier].short : '暂不可用'
      }
      body.appendChild(
        el('tr', {}, [
          el('td', {}, [
            el('a', { class: 'model-name', href: detailHref(m.name), text: m.name }),
            m.desc ? el('div', { class: 'model-desc', text: m.desc }) : null
          ]),
          el('td', { class: 'col-vendor', style: 'color: #374151; white-space: nowrap;', text: m.vendor }),
          priceCell(m.official.input, ratio),
          priceCell(m.official.output, ratio),
          priceCell(m.cache.read, ratio),
          el('td', {}, [badge])
        ])
      )
    })
  }

  function renderImages() {
    var box = document.getElementById('image-cards')
    box.textContent = ''
    imageModels.forEach(function (m) {
      var ratio = TR.ratioFor(pricing, m.name, '生图')
      var price = m.perImage == null || ratio == null
        ? el('span', { style: 'font-size: 14px; color: #4B5563;', text: '按用量计费，点模型名看详情' })
        : el('span', { class: 'num', style: 'font-size: 20px;', text: TR.yuan(m.perImage * TR.USD_TO_CNY * ratio) + ' / 张' })
      box.appendChild(
        el('div', { class: 'img-card' }, [
          el('a', { class: 'model-name', href: detailHref(m.name), text: m.name }),
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
    document.getElementById('tier-name').textContent = TR.TIERS[state.tier].label
    document.getElementById('tier-note').textContent = TR.TIERS[state.tier].note
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

  TR.fetchPricing()
    .then(function (j) {
      pricing = j
      prepare()
      render()
      renderImages()
    })
    .catch(function () {
      var body = document.getElementById('text-rows')
      body.textContent = ''
      body.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'status', text: '价格暂时没加载出来，请刷新重试' })]))
    })
})()
