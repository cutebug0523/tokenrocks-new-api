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
import type { PaymentMethod } from '@/features/wallet/types'

export interface DistributorOrder {
  id: number
  face_value: number
  count: number
  money: number
  payment_method: string
  batch_name: string
  status: string
  create_time: number
  complete_time: number
}

export interface DistributorMonth {
  month: string
  count: number
  money: number
}

export interface DistributorMember {
  name: string
  /** When the user started counting as this distributor's; 0 is the distributor. */
  since: number
  /** All online top-ups (amount paid) and the part already spent. */
  paid: number
  spent: number
}

export interface DistributorChild {
  no: number
  users: number
  paid: number
  /** This distributor's share of the money spent and not yet spent. */
  earned: number
  pending: number
}

export interface DistributorPayout {
  /** Beijing date, YYYY-MM-DD. */
  date: string
  amount: number
}

export interface DistributorSelf {
  enabled: boolean
  no?: number
  face_values?: number[]
  min_count?: number
  max_count?: number
  commission_rate?: number
  parent_commission_rate?: number
  pay_methods?: PaymentMethod[]
  stats?: {
    codes_total: number
    codes_redeemed: number
    users: number
    months: DistributorMonth[]
    /** Online top-ups by this distributor's own users. */
    paid: number
    /** Commission on money not spent yet; includes sub-distributor shares. */
    pending: number
    /** Commission on money already spent, minus payouts. */
    withdrawable: number
    withdrawn: number
    payouts: DistributorPayout[]
    children?: DistributorChild[]
    /** This distributor's own users; emails and phone numbers come masked. */
    members?: DistributorMember[]
  }
  orders?: DistributorOrder[]
}

export interface DistributorOrderRequest {
  face_value: number
  count: number
  payment_method: string
}

export interface DistributorCodes {
  face_value: number
  batch_name: string
  codes: string[]
}
