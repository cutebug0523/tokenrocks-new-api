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
import type { TFunction } from 'i18next'

import { formatNumber } from '@/lib/format'

import type { PricingModel } from '../types'
import { getDisplayGroupRatio } from './model-helpers'

/**
 * The group whose price a model summary shows, with its ratio. Follows
 * getDisplayGroupRatio: the selected group when it applies, otherwise the
 * cheapest enabled group.
 */
export function getDisplayGroup(
  model: PricingModel,
  selectedGroup?: string
): { group?: string; ratio: number } {
  const ratio = getDisplayGroupRatio(model, selectedGroup)
  const groups = Array.isArray(model.enable_groups) ? model.enable_groups : []
  if (selectedGroup && groups.includes(selectedGroup)) {
    return { group: selectedGroup, ratio }
  }
  return { group: groups.find((g) => model.group_ratio?.[g] === ratio), ratio }
}

/**
 * Discount text for a ratio below 1, e.g. "0.6折" in Chinese and "94% off"
 * elsewhere. Returns null when the price is not discounted.
 */
export function formatGroupDiscount(
  ratio: number,
  t: TFunction,
  locale: string | undefined
): string | null {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio >= 1) return null
  return t('{{percentOff}}% off', {
    percentOff: formatNumber((1 - ratio) * 100, locale),
    zhe: formatNumber(ratio * 10, locale),
  })
}

/**
 * The same model priced at ratio 1. Pricing helpers read group ratios from
 * model.group_ratio, so an empty map yields the official (base) price.
 */
export function toOfficialPriceModel(model: PricingModel): PricingModel {
  return { ...model, group_ratio: {} }
}
