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
import { render, screen } from '@testing-library/react'
import i18next from 'i18next'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

import { toIntlLocale } from '@/i18n/languages'
import en from '@/i18n/locales/en.json'
import fr from '@/i18n/locales/fr.json'
import ja from '@/i18n/locales/ja.json'
import ru from '@/i18n/locales/ru.json'
import vietnamese from '@/i18n/locales/vi.json'
import zhTW from '@/i18n/locales/zh-TW.json'
import zh from '@/i18n/locales/zh.json'
import { api } from '@/lib/api'

import { ModelCard } from '../components/model-card'
import { ModelDetailsContent } from '../components/model-details'
import { formatGroupDiscount } from '../lib/group-discount'
import type { PricingModel } from '../types'

vi.mock('@visactor/react-vchart', () => ({ VChart: () => null }))

const locales = { en, fr, ja, ru, vi: vietnamese, zhCN: zh, zhTW }

beforeAll(() => {
  for (const [code, resource] of Object.entries(locales)) {
    i18next.addResourceBundle(code, 'translation', resource.translation)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const claude: PricingModel = {
  id: 1,
  model_name: 'claude-fable-5',
  quota_type: 0,
  model_ratio: 5,
  completion_ratio: 5,
  enable_groups: ['国外特价', '国外企业满血'],
  group_ratio: { 国外特价: 0.06, 国外企业满血: 0.3 },
}

function struckPrices(container: HTMLElement): string[] {
  return [...container.querySelectorAll('s')].map((s) => s.textContent ?? '')
}

it.each([
  ['zhCN', '0.6折'],
  ['zhTW', '0.6折'],
  ['en', '94% off'],
  ['fr', '-94 %'],
  ['ja', '94%オフ'],
  ['ru', '−94%'],
  ['vi', 'Giảm 94%'],
  ['xx', '94% off'],
])(
  'formats a 0.06 ratio for the %s interface language as %s',
  (code, expected) => {
    const discount = formatGroupDiscount(
      0.06,
      i18next.getFixedT(code),
      toIntlLocale(code)
    )

    expect(discount).toBe(expected)
  }
)

it('formats whole and fractional zhe values and hides a discount at or above full price', () => {
  const zhT = i18next.getFixedT('zhCN')

  expect(formatGroupDiscount(0.3, zhT, 'zh-CN')).toBe('3折')
  expect(formatGroupDiscount(0.12, zhT, 'zh-CN')).toBe('1.2折')
  expect(formatGroupDiscount(1, zhT, 'zh-CN')).toBeNull()
  expect(formatGroupDiscount(1.5, zhT, 'zh-CN')).toBeNull()
})

it('shows the cheapest group, its discount and the struck official price on a card without a group filter', () => {
  const { container } = render(<ModelCard model={claude} onClick={() => {}} />)

  expect(screen.getByText('国外特价 price')).toBeVisible()
  expect(screen.getByText('94% off')).toBeVisible()
  expect(screen.getByText(/^\$0\.6\b/)).toBeVisible()
  expect(struckPrices(container)).toEqual([
    expect.stringMatching(/^Official price \$10(\.0+)?$/),
    expect.stringMatching(/^Official price \$50(\.0+)?$/),
  ])
})

it('shows the filtered group and its discount on a card when a group is selected', () => {
  render(
    <ModelCard model={claude} onClick={() => {}} selectedGroup='国外企业满血' />
  )

  expect(screen.getByText('国外企业满血 price')).toBeVisible()
  expect(screen.getByText('70% off')).toBeVisible()
  expect(screen.getByText(/^\$3\b/)).toBeVisible()
})

it('shows no discount or struck price on a card priced at full price', () => {
  const { container } = render(
    <ModelCard
      model={{ ...claude, enable_groups: ['生图'], group_ratio: { 生图: 1 } }}
      onClick={() => {}}
    />
  )

  expect(screen.queryByText(/% off$/)).not.toBeInTheDocument()
  expect(screen.queryByText(/price$/)).not.toBeInTheDocument()
  expect(struckPrices(container)).toEqual([])
})

it('lists group prices before the official price and labels group discounts in details', () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { data: { groups: [] } } })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  render(
    <QueryClientProvider client={client}>
      <ModelDetailsContent
        model={claude}
        groupRatio={{ 国外特价: 0.06, 国外企业满血: 0.3 }}
        usableGroup={{
          国外特价: { desc: '', ratio: 0.06 },
          国外企业满血: { desc: '', ratio: 0.3 },
        }}
        endpointMap={{}}
        autoGroups={[]}
        priceRate={1}
        usdExchangeRate={7}
        tokenUnit='M'
      />
    </QueryClientProvider>
  )

  const groupTitle = screen.getByText('Pricing by Group')
  const officialTitle = screen.getByText('Official price')
  expect(
    groupTitle.compareDocumentPosition(officialTitle) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  expect(screen.getByText('94% off')).toBeVisible()
  expect(screen.getByText('70% off')).toBeVisible()
  expect(screen.queryByText('0.06x')).not.toBeInTheDocument()
  client.clear()
})

it('lists the group whose price is shown first in the card group field', () => {
  const model = { ...claude, enable_groups: ['国外企业满血', '国外特价'] }
  const { rerender } = render(<ModelCard model={model} onClick={() => {}} />)
  const groupField = () =>
    screen.getByText('Groups').parentElement as HTMLElement

  expect(groupField()).toHaveTextContent(/Groups国外特价\+1/)

  rerender(
    <ModelCard model={model} onClick={() => {}} selectedGroup='国外企业满血' />
  )

  expect(groupField()).toHaveTextContent(/Groups国外企业满血\+1/)
})
