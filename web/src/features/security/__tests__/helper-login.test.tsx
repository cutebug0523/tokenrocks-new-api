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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { HelperLogin } from '../helper-login'
import { helperLoginSearchSchema } from '../lib/helper-login'

vi.mock('@/features/auth/auth-layout', () => ({
  AuthLayout: (props: { children: React.ReactNode }) => props.children,
}))

const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const assign = vi.fn()

function renderPage(search: Record<string, unknown>) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <HelperLogin search={helperLoginSearchSchema.parse(search)} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.stubGlobal('location', { ...window.location, assign })
})

afterEach(() => {
  cleanup()
  assign.mockReset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('hands the approved code and state to the helper loopback port', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: { code: 'one-time-code' } } })
  renderPage({ code_challenge: challenge, state: 'helper-state-123456', port: 51234 })

  await userEvent.setup().click(screen.getByRole('button', { name: 'Authorize' }))

  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith(
      'http://127.0.0.1:51234/callback?code=one-time-code&state=helper-state-123456'
    )
  )
  expect(post).toHaveBeenCalledWith(
    '/api/user/helper/approve',
    { code_challenge: challenge },
    expect.anything()
  )
  expect(screen.queryByRole('button', { name: 'Authorize' })).toBeNull()
})

it('tells the helper the user cancelled without asking for a code', async () => {
  const post = vi.spyOn(api, 'post')
  renderPage({ code_challenge: challenge, state: 'helper-state-123456', port: 51234 })

  await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }))

  expect(assign).toHaveBeenCalledWith(
    'http://127.0.0.1:51234/callback?error=access_denied&state=helper-state-123456'
  )
  expect(post).not.toHaveBeenCalled()
})

it.each([
  ['a plain challenge', { code_challenge: 'plain', state: 'helper-state-123456', port: 51234 }],
  ['a privileged port', { code_challenge: challenge, state: 'helper-state-123456', port: 80 }],
  ['no state', { code_challenge: challenge, port: 51234 }],
])('offers no authorize button for %s', (_, search) => {
  renderPage(search)
  expect(screen.queryByRole('button', { name: 'Authorize' })).toBeNull()
  expect(
    screen.getByText('This sign-in link is incomplete. Click Sign in in the helper again.')
  ).toBeVisible()
})
