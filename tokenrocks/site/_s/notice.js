// 弹窗公告：内容就是后台「系统设置 → 系统公告」（/api/notice），为空不弹。
// 每次打开或刷新页面都弹；控制台从登录、注册这类页面进到别的页面（也就是刚登录完）时再弹一次，登录页本身不弹。
// 「知道了」、点遮罩、按 Esc 只关这一次；勾了「今日不再弹出」，当天同一条公告不再弹，改了内容当天也会重新弹。
// 由 wechat.js 加载，所以官网静态页和控制台都有。公告是 Markdown，这里只认段落、换行、**加粗**、# 标题行和网址；
// sk- 开头的密钥单独成块，带一键复制（手机上长按很难选全）。
;(function () {
  var KEY = 'tokenrocks_notice_snooze'
  var AUTH = /^\/(sign-in|sign-up|register|forgot-password|reset|otp|oauth|user\/reset)(\/|$)/
  var text = ''

  fetch('/api/notice', { cache: 'no-store', credentials: 'same-origin' })
    .then(function (r) { return r.json() })
    .then(function (j) {
      text = ((j && j.success && j.data) || '').trim()
      if (!AUTH.test(location.pathname)) show()
    })
    .catch(function () {})

  // 控制台是单页应用，登录后不刷新页面，只能看地址从登录页变成别的页面
  var wasAuth = AUTH.test(location.pathname)
  setInterval(function () {
    var isAuth = AUTH.test(location.pathname)
    if (wasAuth && !isAuth) show()
    wasAuth = isAuth
  }, 1000)

  function today() {
    var d = new Date()
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  function hash(s) {
    var h = 5381
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return String(h >>> 0)
  }

  function render(s) {
    return s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .split(/\n{2,}/)
      .map(function (block) {
        return '<p>' + block.split('\n').map(function (line) {
          var heading = /^#{1,6}\s+/.test(line)
          line = line.replace(/^#{1,6}\s+/, '')
            .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
            .replace(/https?:\/\/[^\s<]+/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>' })
            .replace(/\bsk-[A-Za-z0-9]{16,}/g, function (k) { return '<span class="tn-key"><code>' + k + '</code><button type="button" class="tn-copy" data-key="' + k + '">复制</button></span>' })
          return heading ? '<b class="tn-h">' + line + '</b>' : line
        }).join('<br>') + '</p>'
      })
      .join('')
  }

  function copyKey(btn) {
    var key = btn.getAttribute('data-key')
    function done() {
      btn.textContent = '已复制'
      setTimeout(function () { btn.textContent = '复制' }, 1500)
    }
    // 微信等内置浏览器可能没有 clipboard 接口，退回到选中隐藏文本框再复制
    function fallback() {
      var t = document.createElement('textarea')
      t.value = key
      t.setAttribute('readonly', '')
      t.style.cssText = 'position:fixed;top:0;opacity:0'
      document.body.appendChild(t)
      t.select()
      try {
        document.execCommand('copy')
      } catch (e) {}
      t.remove()
      done()
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(key).then(done, fallback)
    else fallback()
  }

  function show() {
    if (!text || document.querySelector('.tn-mask')) return
    var mark = today() + '|' + hash(text)
    try {
      if (localStorage.getItem(KEY) === mark) return
    } catch (e) {}
    if (!document.getElementById('tn-style')) {
      var style = document.createElement('style')
      style.id = 'tn-style'
      style.textContent =
        '.tn-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(17,24,39,.5);display:flex;align-items:center;justify-content:center;padding:16px}' +
        '.tn-box{width:min(680px,100%);max-height:86vh;overflow:auto;background:#fff;color:#111827;border-radius:20px;box-shadow:0 24px 72px rgba(0,0,0,.28);padding:36px 40px 28px;font:17px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}' +
        '.tn-title{margin:0 0 14px;font-size:26px;font-weight:800;line-height:1.3}' +
        '.tn-body{overflow-wrap:anywhere}.tn-body p{margin:0 0 14px;color:#374151}.tn-body a{color:#0E7C66}.tn-h{display:inline-block;font-size:20px;line-height:1.5;color:#111827}' +
        '.tn-foot{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px;flex-wrap:wrap}' +
        '.tn-skip{display:flex;align-items:center;gap:8px;font-size:15px;color:#6B7280;cursor:pointer;user-select:none}.tn-skip input{width:18px;height:18px;margin:0;accent-color:#0E7C66;cursor:pointer}' +
        '.tn-key{display:flex;align-items:center;gap:10px;margin:6px 0;padding:10px 12px;background:#F3F4F6;border:1px solid #E5E7EB;border-radius:10px;font-weight:400}' +
        '.tn-key code{flex:1;min-width:0;font:600 15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;color:#111827}' +
        '.tn-copy{flex:none;min-height:36px;padding:0 16px;border:0;border-radius:8px;background:#0E7C66;color:#fff;font-size:14px;font-weight:600;cursor:pointer}' +
        '.tn-ok{min-height:48px;padding:0 32px;border:0;border-radius:10px;background:#0E7C66;color:#fff;font-size:17px;font-weight:600;cursor:pointer}' +
        '@media (max-width:640px){.tn-box{padding:28px 22px 22px;font-size:16px}.tn-title{font-size:22px}.tn-h{font-size:18px}.tn-ok{flex:1}}'
      document.head.appendChild(style)
    }
    var mask = document.createElement('div')
    mask.className = 'tn-mask'
    mask.innerHTML =
      '<div class="tn-box" role="dialog" aria-modal="true" aria-labelledby="tn-title">' +
      '<h2 class="tn-title" id="tn-title">公告</h2>' +
      '<div class="tn-body">' + render(text) + '</div>' +
      '<div class="tn-foot"><label class="tn-skip"><input type="checkbox">今日不再弹出</label>' +
      '<button type="button" class="tn-ok">知道了</button></div></div>'
    document.body.appendChild(mask)
    var ok = mask.querySelector('.tn-ok')
    var skip = mask.querySelector('.tn-skip input')
    ok.focus()
    function close() {
      if (skip.checked) {
        try {
          localStorage.setItem(KEY, mark)
        } catch (e) {}
      }
      mask.remove()
      document.removeEventListener('keydown', onKey)
    }
    function onKey(e) {
      if (e.key === 'Escape') close()
    }
    ok.addEventListener('click', close)
    mask.addEventListener('click', function (e) {
      var copyBtn = e.target.closest && e.target.closest('.tn-copy')
      if (copyBtn) return copyKey(copyBtn)
      if (e.target === mask) close()
    })
    document.addEventListener('keydown', onKey)
  }
})()
