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
import { expect, test } from 'vitest'

import { calculatePresetPricing } from '../format'
import { getTopupAmountScale, isYuanTopupRecord } from '../payment'

test('in CNY mode a ¥100 preset shows 100 and charges ¥100', () => {
  const scale = getTopupAmountScale('CNY', 7, 7)
  const pricing = calculatePresetPricing(
    100,
    scale.priceRatio,
    1,
    scale.displayRate
  )
  expect(pricing.displayValue).toBe(100)
  expect(pricing.actualPrice).toBe(100)
})

test('in USD mode amounts stay in dollars and charge the configured price', () => {
  expect(getTopupAmountScale('USD', 7, 7)).toEqual({
    displayRate: 1,
    priceRatio: 7,
  })
})

test('in custom currency mode presets are still converted by the exchange rate', () => {
  expect(getTopupAmountScale('CUSTOM', 7.3, 7.3)).toEqual({
    displayRate: 7.3,
    priceRatio: 7.3,
  })
})

test('only epay records in CNY mode store their amount in yuan', () => {
  expect(isYuanTopupRecord({ payment_provider: 'epay' }, 'CNY')).toBe(true)
  expect(isYuanTopupRecord({ payment_provider: 'stripe' }, 'CNY')).toBe(false)
  expect(isYuanTopupRecord({ payment_provider: 'epay' }, 'USD')).toBe(false)
})
