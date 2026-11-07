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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { STATUS_QUERY_KEY } from '@/lib/status-query'

type Options = Record<string, (...args: unknown[]) => unknown>

let turnstileOptions: Options | undefined
let aliyunOptions: Record<string, unknown> | undefined

beforeEach(() => {
  // 组件模块里记着「这一页 Turnstile 失败过」，每个用例重新加载模块
  vi.resetModules()
  turnstileOptions = undefined
  aliyunOptions = undefined
  window.turnstile = {
    render: (element, options) => {
      turnstileOptions = options as Options
      // 真 Turnstile 会往容器里塞自己的框
      const widget = document.createElement('div')
      widget.dataset.testid = 'cf-widget'
      element.appendChild(widget)
    },
  }
  window.initAliyunCaptcha = (options) => {
    aliyunOptions = options
  }
  // 阿里云脚本当作已经加载好，不发网络请求
  const script = document.createElement('script')
  script.id = 'aliyun-captcha'
  script.dataset.loaded = '1'
  document.head.appendChild(script)
})

afterEach(() => {
  vi.useRealTimers()
  document.getElementById('aliyun-captcha')?.remove()
  delete window.turnstile
  delete window.initAliyunCaptcha
  delete window.AliyunCaptchaConfig
})

async function renderCaptcha(aliyunConfigured: boolean) {
  const { Turnstile } = await import('../turnstile')
  const client = new QueryClient()
  client.setQueryData(
    STATUS_QUERY_KEY,
    aliyunConfigured
      ? { aliyun_captcha_prefix: 'pfx', aliyun_captcha_scene_id: 'scene-1' }
      : {}
  )
  const onVerify = vi.fn()
  const onExpire = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <Turnstile siteKey='site' onVerify={onVerify} onExpire={onExpire} />
    </QueryClientProvider>
  )
  return { onVerify, onExpire }
}

function forgetAliyunSetup() {
  aliyunOptions = undefined
}

function passAliyun(param: string) {
  const success = aliyunOptions?.success
  if (typeof success !== 'function') throw new Error('Aliyun was not set up')
  success(param)
}

// 等 loadScript 的 Promise 和 React 提交都跑完
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

test('when Turnstile errors, the Aliyun slider appears and its result is passed on as an ali. token', async () => {
  const { onVerify } = await renderCaptcha(true)

  await act(async () => {
    turnstileOptions?.['error-callback']()
  })
  await flush()

  expect(aliyunOptions?.SceneId).toBe('scene-1')
  expect(aliyunOptions?.mode).toBe('embed')
  expect(document.querySelector('[data-testid=cf-widget]')).toBeNull()
  expect(window.AliyunCaptchaConfig).toEqual({ region: 'cn', prefix: 'pfx' })
  const elementSelector = String(aliyunOptions?.element)
  expect(document.querySelector(elementSelector)).not.toBeNull()

  const param = '{"certifyId":"c1","deviceToken":"a+b/c"}'
  act(() => passAliyun(param))
  const token = onVerify.mock.calls.at(-1)?.[0] as string
  expect(token.startsWith('ali.')).toBe(true)
  const encoded = token.slice(4).replaceAll('-', '+').replaceAll('_', '/')
  expect(atob(encoded)).toBe(param)
})

test('when Turnstile gives no answer for 12 seconds, it switches to Aliyun', async () => {
  vi.useFakeTimers()
  await renderCaptcha(true)

  await act(async () => {
    vi.advanceTimersByTime(12000)
  })
  await flush()

  expect(aliyunOptions?.SceneId).toBe('scene-1')
})

test('when Turnstile is waiting for the user to click, it does not switch', async () => {
  vi.useFakeTimers()
  await renderCaptcha(true)

  act(() => {
    turnstileOptions?.['before-interactive-callback']()
  })
  await act(async () => {
    vi.advanceTimersByTime(30000)
  })
  await flush()

  expect(aliyunOptions).toBeUndefined()
})

test('when Aliyun is not configured, a Turnstile error keeps the Turnstile box', async () => {
  const { onExpire } = await renderCaptcha(false)

  await act(async () => {
    turnstileOptions?.['error-callback']()
  })
  await flush()

  expect(onExpire).toHaveBeenCalled()
  expect(aliyunOptions).toBeUndefined()
})

test('an Aliyun token expires after 80 seconds and the slider is set up again', async () => {
  vi.useFakeTimers()
  const { onExpire } = await renderCaptcha(true)
  await act(async () => {
    turnstileOptions?.['error-callback']()
  })
  await flush()
  act(() => passAliyun('{}'))
  onExpire.mockClear()
  forgetAliyunSetup()

  await act(async () => {
    vi.advanceTimersByTime(80000)
  })
  await flush()

  expect(onExpire).toHaveBeenCalledTimes(1)
  expect(aliyunOptions?.SceneId).toBe('scene-1')
})
