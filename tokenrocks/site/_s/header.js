// 已登录时，页头的「登录 / 免费开始」换成用户名和「进入控制台」。
// 是否登录看 new_api_has_session（登录会话的可读标记，随会话过期）；用户名由控制台写进 localStorage。
;(function () {
  if (!/(?:^|;\s*)new_api_has_session=/.test(document.cookie)) return
  var name = ''
  try {
    name = localStorage.getItem('tokenrocks_signed_in_name') || ''
  } catch (e) {}
  var signIn = document.querySelector('.site-header a[href="/sign-in"]')
  var start = document.querySelector('.site-header a[href="/sign-up"]')
  if (signIn) {
    signIn.textContent = name || '我的账户'
    signIn.href = '/dashboard'
    signIn.classList.add('signed-in')
  }
  if (start) {
    start.textContent = '进入控制台'
    start.href = '/dashboard'
  }
})()
