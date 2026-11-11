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
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { DistributorMembersCard } from '../components/distributor-members-card'

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

it('lists each own user with their top-ups and marks the distributor as yourself', () => {
  render(
    <DistributorMembersCard
      members={[
        { name: 'zkzy', since: 1794128000, this_month: 20, last_month: 0 },
        { name: '304***@qq.com', since: 0, this_month: 70, last_month: 5 },
      ]}
    />
  )

  const rows = screen.getAllByRole('row')
  const self = rows.find((row) => within(row).queryByText('304***@qq.com'))
  expect(self).toBeDefined()
  expect(within(self as HTMLElement).getByText('Yourself')).toBeInTheDocument()
  expect(within(self as HTMLElement).getByText('¥70')).toBeInTheDocument()
  expect(screen.getByText('zkzy')).toBeInTheDocument()
})

it('shows an empty state when the distributor has no users yet', () => {
  render(<DistributorMembersCard members={[]} />)

  expect(screen.getByText('No users yet')).toBeInTheDocument()
  expect(screen.queryByRole('row')).not.toBeInTheDocument()
})
