/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useStatus } from '@/hooks/use-status'

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, unknown>) => void
    }
    AliyunCaptchaConfig?: { region: string; prefix: string }
    initAliyunCaptcha?: (options: Record<string, unknown>) => void
  }
}

interface TurnstileProps {
  siteKey: string
  onVerify: (token: string) => void
  onExpire?: () => void
  className?: string
}

const TURNSTILE_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const ALIYUN_SRC =
  'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
// 浏览器过不了 Turnstile（国产浏览器老内核、连不上 Cloudflare、App 内置浏览器等）时换成阿里云验证码。
// 交给表单的票据写成 "ali." + base64url(captchaVerifyParam)，后端 middleware/turnstile-check.go 认这个前缀，
// 所以登录、注册、发验证码、找回密码、签到各处不用改。
const ALIYUN_TOKEN_PREFIX = 'ali.'
// Turnstile 这么久既没通过、也没让用户点，就当卡住了
const TURNSTILE_STUCK_MS = 12000
// 阿里云要求滑完 90 秒内提交（超时回 F019），留点余量到点作废、重新滑
const ALIYUN_TOKEN_TTL_MS = 80000
// 这一页里 Turnstile 失败过一次，之后重绘（比如登录失败后表单换新验证框）直接用阿里云
let turnstileFailed = false

function loadScript(id: string, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let script = document.getElementById(id) as HTMLScriptElement | null
    if (script?.dataset.loaded) {
      resolve()
      return
    }
    if (!script) {
      const created = document.createElement('script')
      created.id = id
      created.src = src
      created.async = true
      created.addEventListener('load', () => {
        created.dataset.loaded = '1'
      })
      document.head.appendChild(created)
      script = created
    }
    script.addEventListener('load', () => resolve())
    script.addEventListener('error', () => reject(new Error(src)))
  })
}

export function Turnstile(props: TurnstileProps) {
  const { i18n } = useTranslation()
  const { status } = useStatus()
  const aliyunPrefix = status?.aliyun_captcha_prefix
  const aliyunSceneId = status?.aliyun_captcha_scene_id
  const aliyunReady = Boolean(aliyunPrefix && aliyunSceneId)
  const [useAliyun, setUseAliyun] = useState(
    () => turnstileFailed && aliyunReady
  )
  // 每加一，阿里云验证框整个换新（票据过期后重新滑）
  const [aliyunRound, setAliyunRound] = useState(0)
  const turnstileRef = useRef<HTMLDivElement | null>(null)
  const aliyunRef = useRef<HTMLDivElement | null>(null)
  const aliyunElementId = `tr-captcha-${useId().replaceAll(/[^\w-]/g, '')}`
  // 表单每次重绘都会传新的回调函数，放进 ref 里，免得因此重新渲染验证框
  const latest = useRef({ props, aliyunReady })
  useEffect(() => {
    latest.current = { props, aliyunReady }
  })

  useEffect(() => {
    if (useAliyun) return
    let settled = false
    let cancelled = false
    const fail = () => {
      if (cancelled || !latest.current.aliyunReady) return
      turnstileFailed = true
      setUseAliyun(true)
    }
    const timer = window.setTimeout(() => {
      if (!settled) fail()
    }, TURNSTILE_STUCK_MS)
    const render = () => {
      if (cancelled || !turnstileRef.current || !window.turnstile) return
      try {
        window.turnstile.render(turnstileRef.current, {
          sitekey: props.siteKey,
          callback: (token: string) => {
            settled = true
            latest.current.props.onVerify(token)
          },
          // 要用户点「确认是真人」不算卡住
          'before-interactive-callback': () => {
            settled = true
          },
          'error-callback': () => {
            settled = true
            latest.current.props.onExpire?.()
            fail()
          },
          'unsupported-callback': () => {
            settled = true
            fail()
          },
          'expired-callback': () => latest.current.props.onExpire?.(),
        })
      } catch {
        fail()
      }
    }
    if (window.turnstile) render()
    else loadScript('cf-turnstile', TURNSTILE_SRC).then(render).catch(fail)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [props.siteKey, useAliyun])

  const language = i18n.language.startsWith('zh') ? 'cn' : 'en'
  useEffect(() => {
    if (!useAliyun || !aliyunPrefix || !aliyunSceneId) return
    let cancelled = false
    let expireTimer = 0
    window.AliyunCaptchaConfig = { region: 'cn', prefix: aliyunPrefix }
    loadScript('aliyun-captcha', ALIYUN_SRC)
      .then(() => {
        const element = aliyunRef.current
        if (cancelled || !element || !window.initAliyunCaptcha) return
        window.initAliyunCaptcha({
          SceneId: aliyunSceneId,
          mode: 'embed',
          element: `#${aliyunElementId}`,
          button: `#${aliyunElementId}-button`,
          language,
          // 滑块铺满表单宽度；阿里云最窄 320，更窄的屏幕整体缩小
          slideStyle: { width: Math.max(320, element.clientWidth), height: 40 },
          rem: Math.min(1, element.clientWidth / 320) || 1,
          success: (param: unknown) => {
            const text =
              typeof param === 'string' ? param : JSON.stringify(param)
            const binary = String.fromCharCode(
              ...new TextEncoder().encode(text)
            )
            const encoded = btoa(binary)
              .replaceAll('+', '-')
              .replaceAll('/', '_')
              .replace(/=+$/, '')
            latest.current.props.onVerify(ALIYUN_TOKEN_PREFIX + encoded)
            expireTimer = window.setTimeout(() => {
              latest.current.props.onExpire?.()
              setAliyunRound((round) => round + 1)
            }, ALIYUN_TOKEN_TTL_MS)
          },
          getInstance: () => {},
        })
      })
      // 阿里云脚本也加载不了就没办法了，留着空框，ts-hint.js 会提示换浏览器
      .catch(() => {})
    return () => {
      cancelled = true
      window.clearTimeout(expireTimer)
    }
  }, [
    useAliyun,
    aliyunPrefix,
    aliyunSceneId,
    aliyunRound,
    aliyunElementId,
    language,
  ])

  // 两种外框用不同 key：换成阿里云时整个换掉 Turnstile 的框，免得它留下的「验证失败」还挂在滑块上面
  if (!useAliyun) {
    return (
      <div key='turnstile' ref={turnstileRef} className={props.className} />
    )
  }
  return (
    <div key='aliyun' className={props.className}>
      <div key={aliyunRound} id={aliyunElementId} ref={aliyunRef} />
      {/* 阿里云初始化要求传一个触发按钮，嵌入式用不上 */}
      <button
        id={`${aliyunElementId}-button`}
        type='button'
        hidden
        tabIndex={-1}
        aria-hidden='true'
      />
    </div>
  )
}
