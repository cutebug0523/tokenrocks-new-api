// 控制台「API 密钥」页顶部的 TokenRocks 小助手下载横幅。按访客的系统只给对应的安装包当主按钮，另一个系统缩成一行小字；手机上压成一两行，写「手机版即将上线」。
// 由 wechat.js 在控制台加载（控制台不用重新打包）。官网教程页的下载卡片不用这个文件，样式和按系统显示都写在那页里（首屏不闪）。
// 安装包由 tr-helper 的 release.sh 传到 /_s/helper/，文件名固定。
;(function () {
  var ua = navigator.userAgent
  // 认法和教程页 <head> 里那段一致：iPad 的 Safari 也自称 Macintosh，靠触屏分开；Linux 之类认不出的两个都给，不挑主按钮
  var os = /Android|iPhone|iPad|iPod|Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'phone'
    : /Windows/.test(ua) ? 'win' : /Macintosh/.test(ua) ? 'mac' : ''

  var style = document.createElement('style')
  style.textContent =
    '.trh-links{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}' +
    '.trh-btn{display:inline-flex;align-items:center;min-height:32px;padding:0 12px;border-radius:8px;border:1px solid #d1d5db;background:#fff;color:#0b1220;font-size:13px;font-weight:600;text-decoration:none}' +
    '.trh-btn:hover{border-color:#0e7c66;color:#0b5d4d}' +
    '.trh-btn.trh-main{background:#0e7c66;border-color:#0e7c66;color:#fff}' +
    '.trh-btn.trh-main:hover{background:#0b5d4d;color:#fff}' +
    '.trh-links .trh-other{font-size:13px;color:#6b7280;text-decoration:underline}' +
    '.trh-more{color:#0e7c66;font-weight:600;text-decoration:none;white-space:nowrap}' +
    '.trh-bar{flex:none;margin:0 12px 8px;padding:10px 14px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;background:#f0faf7;border:1px solid #d1e7e1;border-radius:10px;font-size:14px;line-height:1.6;color:#0b3d33}' +
    '.trh-bar b{margin-right:6px}' +
    '.trh-bar.trh-phone{padding:8px 12px;font-size:13px;line-height:1.5}' +
    '@media (min-width:640px){.trh-bar{margin:0 16px 10px}}' +
    'html.dark .trh-bar{background:rgba(14,124,102,.14);border-color:rgba(14,124,102,.5);color:#cfeee5}' +
    'html.dark .trh-bar .trh-btn:not(.trh-main){background:transparent;border-color:rgba(255,255,255,.22);color:#e5e7eb}' +
    'html.dark .trh-bar .trh-other{color:#9ca3af}' +
    'html.dark .trh-more{color:#5fd0b5}' +
    '.trh-mac-soon{display:none;font-size:13px;font-weight:600;color:#0e7c66}' +
    '.trh-no-mac .trh-bar [data-os="mac"]{display:none}' +
    '.trh-no-mac .trh-mac-soon{display:inline}' +
    'html.dark .trh-mac-soon{color:#5fd0b5}'
  document.head.appendChild(style)

  // Mac 安装包还没传上去（404）就先写「Mac 版即将上线」，传上去以后自动恢复，不用改这里。ponytail: 每次打开控制台多一个 HEAD 请求，两个包都长期在了可以删
  fetch('/_s/helper/TokenRocks-helper.dmg', { method: 'HEAD', cache: 'no-store' }).then(function (r) { if (!r.ok) document.documentElement.classList.add('trh-no-mac') }, function () {})

  // 本系统的按钮排前面、填主色，另一个系统缩成小字
  function mark(box) {
    var mine = os && box.querySelector('[data-os="' + os + '"]')
    if (!mine) return
    mine.classList.add('trh-main')
    box.insertBefore(mine, box.firstChild)
    box.querySelectorAll('.trh-btn:not(.trh-main)').forEach(function (a) { a.className = 'trh-other' })
  }

  // 控制台是单页应用，换页不刷新：页面一有变化就看看是不是在「API 密钥」页、横幅还在不在（换页回来页面重建，横幅会跟着没了）。
  // 在浏览器画出来之前插好，列表不会往下跳。不做关闭按钮，常驻（店主定的）
  // 点进「API 密钥」时地址先变，新页代码下完之前屏幕上还是上一页（手机第一次进常见）：记住在别的页时看到的页面区域，不往那里插
  var old = null
  function banner() {
    var title = document.querySelector('[data-slot="sidebar-inset"] main h2')
    var main = title && title.closest('main')
    if (!/^\/keys\/?$/.test(location.pathname)) { old = main; return }
    if (!main || main === old || document.getElementById('trh-bar')) return
    var head = title.closest('main > div')
    if (!head) return
    var bar = document.createElement('div')
    bar.id = 'trh-bar'
    bar.className = 'trh-bar'
    if (os === 'phone') {
      // 手机上这页高度固定、列表在中间自己滚，横幅高了列表就只剩一条缝：压成一两行，不放按钮
      bar.className += ' trh-phone'
      bar.innerHTML = '<div><b>TR助手</b>电脑上一键配好编程客户端，手机版即将上线</div>'
    } else {
      bar.innerHTML =
        '<div><b>用 DeepSeek Harness、ZCode、WorkBuddy？</b>装 TR助手，登录后点一下就配好，不用复制密钥、一项项填。<a class="trh-more" href="/guide/clients/#helper">怎么用</a></div>' +
        '<div class="trh-links">' +
        '<a class="trh-btn" data-os="mac" href="/_s/helper/TokenRocks-helper.dmg">下载 Mac 版</a>' +
        '<span class="trh-mac-soon">Mac 版即将上线</span>' +
        '<a class="trh-btn" data-os="win" href="/_s/helper/TokenRocks-helper-setup.exe">下载 Windows 版</a>' +
        '</div>'
      mark(bar.querySelector('.trh-links'))
    }
    head.after(bar)
  }
  new MutationObserver(banner).observe(document.body, { childList: true, subtree: true })
  banner()
})()
