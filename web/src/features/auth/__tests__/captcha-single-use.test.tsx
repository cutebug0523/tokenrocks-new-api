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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { ForgotPasswordForm } from '../forgot-password/components/forgot-password-form'
import { SignUpForm } from '../sign-up/components/sign-up-form'

// 人机验证的令牌只能用一次：服务端校验过就作废，失败了也一样。
// 每次挂载假验证框就发一个新令牌，看表单每次提交是不是都换了新的。
const captcha = vi.hoisted(() => ({ issued: 0 }))
const api = vi.hoisted(() => ({
  register: vi.fn(),
  sendEmailVerification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  wechatLoginByCode: vi.fn(),
}))

vi.mock('@/features/auth/api', () => api)
vi.mock('@/components/turnstile', async () => {
  const { useEffect } = await import('react')
  return {
    Turnstile: (props: { onVerify: (token: string) => void }) => {
      useEffect(() => {
        captcha.issued += 1
        props.onVerify(`token-${captcha.issued}`)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return null
    },
  }
})
vi.mock('@/hooks/use-status', () => ({
  useStatus: () => ({
    status: {
      turnstile_check: true,
      turnstile_site_key: 'site-key',
      email_verification: true,
      oauth_register_enabled: false,
    },
  }),
}))
vi.mock('@/features/auth/hooks/use-auth-redirect', () => ({
  useAuthRedirect: () => ({
    redirectToLogin: vi.fn(),
    handleLoginResult: vi.fn(),
  }),
}))

beforeEach(() => {
  captcha.issued = 0
  const failed = { success: false, message: 'Turnstile verification failed' }
  api.register.mockResolvedValue(failed)
  api.sendEmailVerification.mockResolvedValue(failed)
  api.sendPasswordResetEmail.mockResolvedValue(failed)
})

async function clickTwice(name: string) {
  const user = userEvent.setup()
  const button = screen.getByRole('button', { name })
  await waitFor(() => expect(button).toBeEnabled())
  await user.click(button)
  await waitFor(() => expect(button).toBeEnabled())
  await user.click(button)
}

test('sign-up retries registration with a new captcha token', async () => {
  const user = userEvent.setup()
  render(<SignUpForm />)
  await user.type(screen.getByLabelText('Username'), 'newuser')
  await user.type(screen.getByLabelText('Password'), 'password123')
  await user.type(screen.getByLabelText('Confirm password'), 'password123')
  await user.type(
    screen.getByLabelText('Email (required for verification)'),
    'name@example.com'
  )
  await user.type(screen.getByPlaceholderText('Verification code'), '123456')

  await clickTwice('Create account')

  await waitFor(() => expect(api.register).toHaveBeenCalledTimes(2))
  const tokens = api.register.mock.calls.map((call) => call[0].turnstile)
  expect(tokens[0]).toBeTruthy()
  expect(tokens[1]).toBeTruthy()
  expect(tokens[1]).not.toBe(tokens[0])
})

test('sign-up resends the email code with a new captcha token', async () => {
  const user = userEvent.setup()
  render(<SignUpForm />)
  await user.type(
    screen.getByLabelText('Email (required for verification)'),
    'name@example.com'
  )

  await clickTwice('Send code')

  await waitFor(() =>
    expect(api.sendEmailVerification).toHaveBeenCalledTimes(2)
  )
  const tokens = api.sendEmailVerification.mock.calls.map((call) => call[1])
  expect(tokens[0]).toBeTruthy()
  expect(tokens[1]).toBeTruthy()
  expect(tokens[1]).not.toBe(tokens[0])
})

test('forgot password retries with a new captcha token', async () => {
  const user = userEvent.setup()
  render(<ForgotPasswordForm />)
  await user.type(screen.getByLabelText('Email'), 'name@example.com')

  await clickTwice('Send reset email')

  await waitFor(() =>
    expect(api.sendPasswordResetEmail).toHaveBeenCalledTimes(2)
  )
  const tokens = api.sendPasswordResetEmail.mock.calls.map((call) => call[1])
  expect(tokens[0]).toBeTruthy()
  expect(tokens[1]).toBeTruthy()
  expect(tokens[1]).not.toBe(tokens[0])
})
