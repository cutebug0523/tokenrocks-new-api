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
import { api } from '@/lib/api'

import type {
  DistributorCodes,
  DistributorOrderRequest,
  DistributorSelf,
} from './types'

interface ApiResponse<T> {
  success: boolean
  message: string
  data?: T
}

export async function getDistributorSelf(): Promise<
  ApiResponse<DistributorSelf>
> {
  const res = await api.get('/api/user/distributor')
  return res.data
}

/** Same answer shape as the wallet's epay order: {message, data, url}. */
export async function createDistributorOrder(
  request: DistributorOrderRequest
): Promise<{ message: string; data?: Record<string, unknown>; url?: string }> {
  const res = await api.post('/api/user/distributor/order', request, {
    skipBusinessError: true,
  })
  return res.data
}

export async function getDistributorOrderCodes(
  orderId: number
): Promise<ApiResponse<DistributorCodes>> {
  const res = await api.get(`/api/user/distributor/order/${orderId}/codes`)
  return res.data
}
