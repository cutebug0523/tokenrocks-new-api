// 每页右下角的「加站长微信」卡片：桌面默认展开，手机默认收成按钮；收起状态记在 localStorage。
// 官网静态页和控制台（web/index.html）共用；样式在 wechat.css，由这里加载，加载完才显示，避免闪出没排版的卡片。
// 控制台引用时带 data-place="side"：收成右边缘中间的竖条，每次都从收起开始，免得挡住表格、翻页和输入框。
// 页面里任何 href="#wechat" 的链接都会打开它。脚本没加载时，页脚的微信号文字还在。
;(function () {
  var ID = 'cutebug0523'
  var KEY = 'tokenrocks_wechat_closed'
  var side = !!document.currentScript && document.currentScript.getAttribute('data-place') === 'side'
  var wrap = document.createElement('div')
  wrap.className = side ? 'wx wx-side' : 'wx'
  wrap.hidden = true
  var css = document.createElement('link')
  css.rel = 'stylesheet'
  css.href = '/_s/wechat.css'
  css.onload = function () {
    wrap.hidden = false
  }
  document.head.appendChild(css)
  wrap.innerHTML =
    '<aside class="wx-card" id="wx-card" aria-label="加站长微信">' +
    '<button type="button" class="wx-close" aria-label="收起">×</button>' +
    '<div class="wx-title">加站长微信</div>' +
    '<p class="wx-text">站长深度接触 AI 四年。充值、企业采购或任何疑问，都可以加我微信。</p>' +
    '<img class="wx-qr" src="/_s/wechat-qr.png" width="168" height="168" alt="站长微信二维码">' +
    '<div class="wx-hint wx-desk">微信扫一扫</div>' +
    '<div class="wx-hint wx-mobile">在微信里打开可长按识别</div>' +
    '<div class="wx-id">微信号 <b>' + ID + '</b><button type="button" class="wx-copy">复制</button></div>' +
    '<a class="wx-open wx-mobile" href="weixin://">复制微信号并打开微信</a>' +
    '</aside>' +
    '<button type="button" class="wx-pill" aria-controls="wx-card" aria-expanded="false">' +
    '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3C4.6 3 1 6 1 9.7c0 2.1 1.2 4 3 5.2L3.3 17l2.6-1.3c1 .3 2 .4 3.1.4h.5a5.6 5.6 0 0 1-.2-1.5C9.3 11 12.9 8 17.3 8h.5C17.1 5.1 13.4 3 9 3Zm-3 4.3a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Zm6 0a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2ZM17.3 9.5c-3.7 0-6.7 2.4-6.7 5.3s3 5.3 6.7 5.3c.8 0 1.6-.1 2.3-.4l2.1 1.1-.6-1.8c1.6-1 2.6-2.5 2.6-4.2 0-2.9-3-5.3-6.4-5.3Zm-2.3 2.8a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm4.6 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z"/></svg>' +
    '加站长微信</button>'
  document.body.appendChild(wrap)

  var pill = wrap.querySelector('.wx-pill')
  var closed = side || window.matchMedia('(max-width: 767px)').matches
  try {
    var saved = localStorage.getItem(KEY)
    if (!side && saved !== null) closed = saved === '1'
  } catch (e) {}
  function setOpen(open, remember) {
    wrap.classList.toggle('open', open)
    pill.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (!remember || side) return
    try {
      localStorage.setItem(KEY, open ? '0' : '1')
    } catch (e) {}
  }
  setOpen(!closed, false)

  function copyId() {
    if (navigator.clipboard) return navigator.clipboard.writeText(ID).catch(function () {})
  }
  pill.addEventListener('click', function () {
    setOpen(true, true)
  })
  wrap.querySelector('.wx-close').addEventListener('click', function () {
    setOpen(false, true)
    pill.focus()
  })
  var copyBtn = wrap.querySelector('.wx-copy')
  copyBtn.addEventListener('click', function () {
    copyId()
    copyBtn.textContent = '已复制'
    setTimeout(function () {
      copyBtn.textContent = '复制'
    }, 1500)
  })
  // 先复制再跳微信；跳转在复制完成后，避免页面切走时复制还没写进剪贴板
  wrap.querySelector('.wx-open').addEventListener('click', function (e) {
    e.preventDefault()
    Promise.resolve(copyId()).then(function () {
      location.href = 'weixin://'
    })
  })
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href="#wechat"]')
    if (!a) return
    e.preventDefault()
    setOpen(true, false)
  })

  // 弹窗公告也挂在这里：这是官网每页和控制台都已经加载的唯一脚本，控制台不用重新打包
  var notice = document.createElement('script')
  notice.src = '/_s/notice.js'
  document.body.appendChild(notice)
})()
