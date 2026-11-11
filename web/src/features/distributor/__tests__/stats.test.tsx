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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { DistributorStats } from '../components/distributor-stats'
import type { DistributorSelf } from '../types'

beforeEach(() => {
  useSystemConfigStore.getState().setConfig({
    currency: {
      ...DEFAULT_CURRENCY_CONFIG,
      quotaDisplayType: 'CNY',
      usdExchangeRate: 7,
    },
  })
})

afterEach(cleanup)

const month = (money: number, commission: number) => ({
  month: '2026-11',
  count: 1,
  money,
  commission,
})

it('adds the sub-distributor share to the commission tile and lists each sub-distributor', () => {
  const self: DistributorSelf = {
    enabled: true,
    no: 1,
    commission_rate: 0.1,
    parent_commission_rate: 0.05,
    stats: {
      codes_total: 50,
      codes_redeemed: 13,
      users: 12,
      months: [month(160, 16), month(0, 0)],
      children: [{ no: 3, users: 3, months: [month(90, 4.5), month(0, 0)] }],
    },
  }
  render(<DistributorStats self={self} />)

  const section = screen.getByRole('region', { name: 'Sub-distributors' })
  expect(section).toHaveTextContent('No. 3 · 3 users')
  expect(section).toHaveTextContent('your share ¥4.5')
  expect(screen.getByText('¥20.5')).toBeInTheDocument()
})

it('shows no sub-distributor section when the distributor has none', () => {
  const self: DistributorSelf = {
    enabled: true,
    no: 3,
    stats: {
      codes_total: 51,
      codes_redeemed: 3,
      users: 3,
      months: [month(90, 9), month(0, 0)],
      children: [],
    },
  }
  render(<DistributorStats self={self} />)

  expect(
    screen.queryByRole('region', { name: 'Sub-distributors' })
  ).not.toBeInTheDocument()
  expect(screen.getByText('¥9')).toBeInTheDocument()
})
