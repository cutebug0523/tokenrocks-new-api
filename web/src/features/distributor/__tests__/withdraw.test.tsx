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
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import {
  DistributorWithdrawCard,
  DistributorWithdrawalsAdminCard,
} from '../components/distributor-withdraw-card'
import type { DistributorSelf, DistributorWithdrawal } from '../types'

const stats = (withdrawable: number) => ({
  codes_total: 0,
  codes_redeemed: 0,
  users: 0,
  months: [],
  paid: 0,
  pending: 0,
  withdrawable,
  withdrawn: 0,
  payouts: [],
})

const request = (
  over: Partial<DistributorWithdrawal> = {}
): DistributorWithdrawal => ({
  id: 1,
  distributor_no: 7,
  user_id: 70,
  amount: 149.2,
  account: '张三 支付宝 139',
  status: 'pending',
  note: '',
  create_time: 1795000000,
  done_time: 0,
  ...over,
})

const wrap = (node: ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>
  )

beforeEach(() => {
  useSystemConfigStore.getState().setConfig({
    currency: {
      ...DEFAULT_CURRENCY_CONFIG,
      quotaDisplayType: 'CNY',
      usdExchangeRate: 7,
    },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('keeps the button off below the minimum', () => {
  wrap(
    <DistributorWithdrawCard
      self={{
        enabled: true,
        withdraw_min: 50,
        withdraw_account: '张三 支付宝 139',
        stats: stats(25.3),
      }}
    />
  )
  expect(screen.getByRole('button', { name: 'Withdraw ¥25.3' })).toBeDisabled()
  expect(
    screen.getByText('You can withdraw once at least ¥50 is withdrawable')
  ).toBeInTheDocument()
})

it('sends the account and withdraws everything', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: request() } })
  const user = userEvent.setup()
  wrap(
    <DistributorWithdrawCard
      self={{ enabled: true, withdraw_min: 50, stats: stats(149.2) }}
    />
  )
  const button = screen.getByRole('button', { name: 'Withdraw ¥149.2' })
  expect(button).toBeDisabled()
  await user.type(
    screen.getByLabelText('Where should we pay you'),
    ' 张三 支付宝 139 '
  )
  await user.click(button)

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/distributor/withdraw', {
      account: '张三 支付宝 139',
    })
  )
})

it('shows the request in progress instead of the form', () => {
  const self: DistributorSelf = {
    enabled: true,
    withdraw_min: 50,
    stats: { ...stats(0), requested: 149.2 },
    withdrawals: [
      request(),
      request({
        id: 0,
        amount: 3,
        status: 'rejected',
        note: '卡号不对',
        done_time: 1795000000,
      }),
    ],
  }
  wrap(<DistributorWithdrawCard self={self} />)

  expect(
    screen.getByText(/¥149.2 requested on .*, waiting to be paid/)
  ).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(
    screen.getByRole('list', { name: 'Withdrawal requests' })
  ).toHaveTextContent('¥3 · Rejected · 卡号不对')
})

it('lets an admin mark a request paid with a note', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: [request()] },
  })
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: request() } })
  const user = userEvent.setup()
  wrap(<DistributorWithdrawalsAdminCard />)

  expect(await screen.findByText('张三 支付宝 139')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Mark paid' }))
  await user.type(
    screen.getByLabelText('Note, the distributor sees it (optional)'),
    '对公 11-25'
  )
  await user.click(screen.getByRole('button', { name: 'Continue' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/distributor/withdrawals/1', {
      action: 'paid',
      note: '对公 11-25',
    })
  )
})

it('shows an error instead of an empty list when requests fail to load', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('network down'))
  wrap(<DistributorWithdrawalsAdminCard />)

  expect(
    await screen.findByRole('button', { name: /retry/i })
  ).toBeInTheDocument()
  expect(screen.queryByText('No withdrawal requests')).not.toBeInTheDocument()
})

it('closes the dialog and reloads when the request was already handled', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue({ data: { success: true, data: [request()] } })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: false,
      message: 'This withdrawal has already been handled',
    },
  })
  const user = userEvent.setup()
  wrap(<DistributorWithdrawalsAdminCard />)

  await user.click(await screen.findByRole('button', { name: 'Reject' }))
  await user.click(screen.getByRole('button', { name: 'Continue' }))

  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
})
