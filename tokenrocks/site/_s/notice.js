// 弹窗公告：内容就是后台「系统设置 → 系统公告」（/api/notice），为空不弹。
// 只给登录用户弹：控制台登录后的页面（有侧边栏框架）每次打开或刷新都弹，刚登录完也弹一次；官网静态页、登录注册页、没登录的人都不弹。
// 刚注册的人这一趟不弹（同一个标签页里去过注册页就算），让闲鱼来的人先安心兑换试用，下次再来才弹。
// 「知道了」、点遮罩、按 Esc 只关这一次；勾了「今日不再弹出」，当天同一条公告不再弹，改了内容当天也会重新弹。
// 由 wechat.js 加载，官网静态页和控制台都会加载。公告是 Markdown，这里只认段落、换行、**加粗**、# 标题行和网址；
// sk- 开头的密钥单独成块，带一键复制（手机上长按很难选全）；单独一行的 ![说明](/_s/图片) 显示成图片（比如群二维码），只认本站 /_s/ 下的图。
;(function () {
  var KEY = 'tokenrocks_notice_snooze'
  var NEW = 'tokenrocks_notice_new_signup'
  var SIGN_UP = /^\/(sign-up|register)(\/|$)/
  var text = ''

  // 控制台的侧边栏框架（web/src/components/ui/sidebar.tsx 的 SidebarProvider）只在登录后的页面渲染，手机上也有
  function loggedIn() {
    return !!document.querySelector('[data-slot="sidebar-wrapper"]')
  }

  function markSignUp() {
    if (!SIGN_UP.test(location.pathname)) return
    try {
      sessionStorage.setItem(NEW, '1')
    } catch (e) {}
  }

  markSignUp()
  // 控制台一开就是半天，不刷新就看不到新公告：登录后每 2 分钟再拉一次，内容变了才弹（没变不重复弹）
  function load() {
    fetch('/api/notice', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        var next = ((j && j.success && j.data) || '').trim()
        if (next === text) return
        text = next
        show()
      })
      .catch(function () {})
  }
  load()
  setInterval(function () {
    if (loggedIn()) load()
  }, 120000)

  // 控制台是单页应用，登录、换页都不刷新页面，只能隔一秒看看框架有没有出现、地址有没有变成注册页
  var wasIn = false
  setInterval(function () {
    markSignUp()
    var isIn = loggedIn()
    if (isIn && !wasIn) show()
    wasIn = isIn
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
            .replace(/^!\[([^\]]*)\]\((\/_s\/[\w.\/-]+)\)$/, '<img class="tn-img" src="$2" alt="$1">')
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
    if (!text || !loggedIn() || document.querySelector('.tn-mask')) return
    var mark = today() + '|' + hash(text)
    try {
      if (localStorage.getItem(KEY) === mark || sessionStorage.getItem(NEW)) return
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
        '.tn-img{display:block;width:180px;height:180px;margin:8px 0 4px;border-radius:8px}' +
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
    ok.focus({ preventScroll: true })
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
