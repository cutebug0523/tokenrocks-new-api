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
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import { useAuthStore } from '@/stores/auth-store'

import { DailyCheckinButton } from '../daily-checkin-button'

let client: QueryClient
let checkinEnabled: boolean
let checkedToday: boolean

beforeEach(() => {
  window.localStorage.clear()
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'u', role: 1, quota: 100 })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  checkinEnabled = true
  checkedToday = false
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/status') {
      return {
        data: { success: true, data: { checkin_enabled: checkinEnabled } },
      }
    }
    if (url.startsWith('/api/user/checkin?month=')) {
      const records = checkedToday
        ? [{ checkin_date: dayjs().format('YYYY-MM-DD'), quota_awarded: 2000 }]
        : []
      return {
        data: {
          success: true,
          data: {
            enabled: true,
            stats: { checked_in_today: checkedToday, records },
          },
        },
      }
    }
    if (url === '/api/user/self') {
      return {
        data: {
          success: true,
          data: { id: 1, username: 'u', role: 1, quota: 2100 },
        },
      }
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url !== '/api/user/checkin') {
      throw new Error(`Unexpected request: ${url}`)
    }
    checkedToday = true
    return { data: { success: true, data: { quota_awarded: 2000 } } }
  })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  window.localStorage.clear()
})

async function renderButton() {
  const router = createRouter({
    routeTree: createRootRoute({ component: DailyCheckinButton }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

describe('overview daily check-in', () => {
  it('checks in on click, then shows the award and the new balance', async () => {
    const user = userEvent.setup()
    await renderButton()

    await user.click(
      await screen.findByRole('button', { name: 'Check in now' })
    )

    expect(
      await screen.findByRole('button', { name: 'Checked in' })
    ).toBeDisabled()
    expect(api.post).toHaveBeenCalledWith('/api/user/checkin')
    expect(useAuthStore.getState().auth.user?.quota).toBe(2100)
  })

  it('shows a disabled button when the user already checked in today', async () => {
    checkedToday = true
    await renderButton()

    expect(
      await screen.findByRole('button', { name: 'Checked in' })
    ).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Check in now' })
    ).not.toBeInTheDocument()
  })

  it('renders nothing when check-in is turned off', async () => {
    checkinEnabled = false
    await renderButton()

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/status'))
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
