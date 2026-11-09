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
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { DistributorOrderCard } from '../components/distributor-order-card'
import type { DistributorSelf } from '../types'

const self: DistributorSelf = {
  enabled: true,
  no: 1,
  face_values: [1, 2, 5],
  min_count: 10,
  max_count: 500,
  pay_methods: [{ name: 'Alipay', type: 'alipay' }],
}

let submitted: { action: string; fields: Record<string, string> }[] = []

beforeEach(() => {
  useSystemConfigStore.getState().setConfig({
    currency: {
      ...DEFAULT_CURRENCY_CONFIG,
      quotaDisplayType: 'CNY',
      usdExchangeRate: 7,
    },
  })
  submitted = []
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (
    this: HTMLFormElement
  ) {
    submitted.push({
      action: this.action,
      fields: Object.fromEntries(
        [...this.querySelectorAll('input')].map((input) => [
          input.name,
          input.value,
        ])
      ),
    })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})

it('disables payment and flags the quantity when it is below the minimum', async () => {
  const user = userEvent.setup()
  render(<DistributorOrderCard self={self} />)

  const quantity = screen.getByLabelText('Quantity')
  await user.clear(quantity)
  await user.type(quantity, '5')

  expect(quantity).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByRole('button', { name: /Alipay/ })).toBeDisabled()
})

it('orders the chosen face value and quantity, then submits the payment form', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      message: 'success',
      url: 'https://pay.example.test/submit.php',
      data: { out_trade_no: 'FX1NOabc', money: '40.00' },
    },
  })
  const user = userEvent.setup()
  render(<DistributorOrderCard self={self} />)

  await user.click(screen.getByRole('button', { name: '¥2' }))
  const quantity = screen.getByLabelText('Quantity')
  await user.clear(quantity)
  await user.type(quantity, '20')
  expect(screen.getByText('¥40')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /Alipay/ }))

  await waitFor(() => expect(submitted).toHaveLength(1))
  expect(post).toHaveBeenCalledWith(
    '/api/user/distributor/order',
    { face_value: 2, count: 20, payment_method: 'alipay' },
    expect.anything()
  )
  expect(submitted[0]).toEqual({
    action: 'https://pay.example.test/submit.php',
    fields: { out_trade_no: 'FX1NOabc', money: '40.00' },
  })
})

it('shows the server reason and does not open payment when the order is rejected', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      message: 'error',
      data: 'This face value is not available',
      message_key: 'This face value is not available',
    },
  })
  const error = vi.spyOn(toast, 'error')
  const user = userEvent.setup()
  render(<DistributorOrderCard self={self} />)

  await user.click(screen.getByRole('button', { name: /Alipay/ }))

  await waitFor(() =>
    expect(error).toHaveBeenCalledWith('This face value is not available')
  )
  expect(submitted).toHaveLength(0)
})
