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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { DistributorOrdersCard } from '../components/distributor-orders-card'
import type { DistributorOrder } from '../types'

const paid: DistributorOrder = {
  id: 15,
  face_value: 2,
  count: 2,
  money: 4,
  payment_method: 'alipay',
  batch_name: '分销-1号-1109-15',
  status: 'success',
  create_time: 1_762_650_000,
  complete_time: 1_762_650_060,
}
const unpaid: DistributorOrder = {
  ...paid,
  id: 16,
  batch_name: '',
  status: 'pending',
  complete_time: 0,
}

const createObjectURL = vi.fn((_blob: Blob) => 'blob:codes')
let downloads: string[] = []

beforeEach(() => {
  downloads = []
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    downloads.push(this.download)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  createObjectURL.mockClear()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

it('offers a download only for paid orders', () => {
  render(
    <DistributorOrdersCard
      orders={[paid, unpaid]}
      refreshing={false}
      onRefresh={() => {}}
    />
  )

  expect(
    screen.getAllByRole('button', { name: 'Download codes' })
  ).toHaveLength(1)
  expect(screen.getByText('Paid')).toBeInTheDocument()
  expect(screen.getByText('Unpaid')).toBeInTheDocument()
})

it('saves a paid order as a txt file named after its batch, one code per line', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        face_value: 2,
        batch_name: paid.batch_name,
        codes: ['a'.repeat(32), 'b'.repeat(32)],
      },
    },
  })
  const user = userEvent.setup()
  render(
    <DistributorOrdersCard
      orders={[paid]}
      refreshing={false}
      onRefresh={() => {}}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Download codes' }))

  await waitFor(() => expect(downloads).toEqual(['分销-1号-1109-15.txt']))
  expect(get).toHaveBeenCalledWith('/api/user/distributor/order/15/codes')
  const blob = createObjectURL.mock.calls[0][0]
  await expect(blob.text()).resolves.toBe(
    `${'a'.repeat(32)}\n${'b'.repeat(32)}\n`
  )
})
