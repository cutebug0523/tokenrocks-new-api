// 模型价格的公共算法：模型与价格页、模型详情页共用。
// 口径和控制台模型广场一致：官方价（美元/百万 token）× 7 = 人民币官方价，
// 再乘分组倍率（模型级覆盖倍率优先）得到本站价格。
;(function () {
  'use strict'

  var TR = (window.TR = window.TR || {})

  TR.USD_TO_CNY = 7
  TR.TIERS = {
    value: { label: '特价线路', short: '特价', match: '特价', note: '价格最低，个别上游附带固定提示词' },
    enterprise: { label: '企业满血线路', short: '企业满血', match: '满血', note: '官方原版模型，稳定优先' }
  }
  TR.VENDOR_ORDER = ['Anthropic', 'OpenAI', 'xAI', 'DeepSeek', '月之暗面', '智谱', '阿里巴巴', 'Google']
  TR.PELICAN_PROMPT = 'Generate an SVG of a pelican riding a bicycle'

  // 用 DOM API 拼节点，接口里的文字一律走 textContent
  TR.el = function (tag, attrs, children) {
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

  TR.yuan = function (n) {
    return '¥' + String(Math.round(n * 10000) / 10000)
  }

  TR.discountLabel = function (ratio) {
    return String(Math.round(ratio * 100) / 10) + '折'
  }

  TR.ratioFor = function (pricing, modelName, group) {
    var override = pricing.model_group_ratio && pricing.model_group_ratio[modelName]
    if (override && override[group] != null) return override[group]
    return pricing.group_ratio[group]
  }

  TR.groupForTier = function (model, tier) {
    var groups = model.enable_groups || []
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].indexOf(TR.TIERS[tier].match) >= 0) return groups[i]
    }
    return null
  }

  TR.isImageModel = function (model) {
    return (model.enable_groups || []).indexOf('生图') >= 0
  }

  // 官方价，美元 / 百万 token。表达式计费的模型取第一档（标准上下文）的 p、c 系数。
  TR.officialTokenPrice = function (model) {
    if (model.billing_mode === 'tiered_expr' && model.billing_expr) {
      var p = /\bp\s*\*\s*([\d.]+)/.exec(model.billing_expr)
      var c = /\bc\s*\*\s*([\d.]+)/.exec(model.billing_expr)
      if (!p || !c) return null
      return { input: Number(p[1]), output: Number(c[1]) }
    }
    return { input: model.model_ratio * 2, output: model.model_ratio * 2 * model.completion_ratio }
  }

  // 缓存价，美元 / 百万 token：read 是缓存命中，write 是缓存写入（和输入同价时为 null，不单列）。
  // 表达式计费取第一档的 cr、cc 系数；倍率计费是输入价乘 cache_ratio、create_cache_ratio。
  TR.officialCachePrice = function (model) {
    var official = TR.officialTokenPrice(model)
    if (!official) return { read: null, write: null }
    if (model.billing_mode === 'tiered_expr' && model.billing_expr) {
      var cr = /\bcr\s*\*\s*([\d.]+)/.exec(model.billing_expr)
      var cc = /\bcc\s*\*\s*([\d.]+)/.exec(model.billing_expr)
      return { read: cr ? Number(cr[1]) : null, write: cc && Number(cc[1]) !== official.input ? Number(cc[1]) : null }
    }
    return {
      read: model.cache_ratio != null ? official.input * model.cache_ratio : null,
      write: model.create_cache_ratio != null && model.create_cache_ratio !== 1 ? official.input * model.create_cache_ratio : null
    }
  }

  // 按张计费的单价（美元），不是按张计费返回 null
  TR.officialImagePrice = function (model) {
    if (model.billing_expr) {
      var f = /fixed\(\s*([\d.]+)\s*\)/.exec(model.billing_expr)
      return f ? Number(f[1]) : null
    }
    if (model.quota_type === 1) return model.model_price
    return null
  }

  TR.vendorName = function (pricing, model) {
    var vendors = pricing.vendors || []
    for (var i = 0; i < vendors.length; i++) {
      if (vendors[i].id === model.vendor_id) return vendors[i].name
    }
    return '其他'
  }

  TR.vendorRank = function (name) {
    var i = TR.VENDOR_ORDER.indexOf(name)
    return i < 0 ? TR.VENDOR_ORDER.length : i
  }

  TR.fetchPricing = function () {
    return fetch('/api/pricing', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error(String(r.status))
        return r.json()
      })
      .then(function (j) {
        if (!j || !j.success || !Array.isArray(j.data)) throw new Error('bad payload')
        return j
      })
  }
})()
