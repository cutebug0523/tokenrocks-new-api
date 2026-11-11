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
import type { Row } from '@tanstack/react-table'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import type { User } from '../../types'
import { DataTableRowActions } from '../data-table-row-actions'
import { UsersProvider } from '../users-provider'

const target: User = {
  id: 2,
  username: 'managed-user',
  display_name: 'Managed user',
  role: 1,
  status: 1,
  quota: 0,
  used_quota: 0,
  request_count: 0,
  group: 'default',
}

function renderRow(distributors: Record<string, number>) {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/user/distributor/users') {
      return { data: { success: true, data: distributors } }
    }
    return { data: { success: true, data: [] } }
  })
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: { no: 8 } } })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <UsersProvider>
        <DataTableRowActions row={{ original: target } as Row<User>} />
      </UsersProvider>
    </QueryClientProvider>
  )
  return post
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('sets a regular user as a distributor without picking a number', async () => {
  const post = renderRow({ '535': 1 })
  await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))
  await userEvent.click(
    await screen.findByRole('menuitem', { name: 'Set as distributor' })
  )
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/distributor/users', {
      user_id: 2,
      enabled: true,
    })
  )
})

it('removes a distributor only after confirming', async () => {
  const post = renderRow({ '2': 7 })
  await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))
  await userEvent.click(
    await screen.findByRole('menuitem', { name: 'Remove distributor No. 7' })
  )
  expect(post).not.toHaveBeenCalled()
  await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/distributor/users', {
      user_id: 2,
      enabled: false,
    })
  )
})
