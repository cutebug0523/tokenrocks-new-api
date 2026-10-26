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
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { ModelDetailsContent } from '../components/model-details'
import { usePricingData } from '../hooks/use-pricing-data'
import type { PricingData, PricingModel } from '../types'

vi.mock('@visactor/react-vchart', () => ({ VChart: () => null }))

const clients: QueryClient[] = []

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
})

function createClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  return client
}

const gptModel: PricingModel = {
  id: 1,
  model_name: 'gpt-6-astra',
  quota_type: 0,
  model_ratio: 5,
  completion_ratio: 5,
  enable_groups: ['foreign', 'foreign-max'],
}

it('merges per-model group ratios over group ratios when pricing loads', async () => {
  const pricing: PricingData = {
    success: true,
    data: [gptModel, { ...gptModel, id: 2, model_name: 'claude-opus-5-5' }],
    vendors: [],
    group_ratio: { foreign: 0.06, 'foreign-max': 0.3 },
    model_group_ratio: {
      'gpt-6-astra': { foreign: 0.05, 'foreign-max': 0.12 },
    },
    usable_group: {},
    supported_endpoint: {},
    auto_groups: [],
  }
  vi.spyOn(api, 'get').mockImplementation(((url: string) =>
    Promise.resolve({
      data: url === '/api/pricing' ? pricing : { success: true, data: {} },
    })) as never)
  const client = createClient()

  const { result } = renderHook(() => usePricingData(), {
    wrapper: (props: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    ),
  })

  await waitFor(() => expect(result.current.models).toHaveLength(2))
  expect(result.current.models[0].group_ratio).toEqual({
    foreign: 0.05,
    'foreign-max': 0.12,
  })
  expect(result.current.models[1].group_ratio).toEqual({
    foreign: 0.06,
    'foreign-max': 0.3,
  })
})

it('shows the model ratio instead of the group ratio in the group price table', () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { data: { groups: [] } } })

  render(
    <QueryClientProvider client={createClient()}>
      <ModelDetailsContent
        model={{
          ...gptModel,
          enable_groups: ['foreign'],
          group_ratio: { foreign: 0.05 },
        }}
        groupRatio={{ foreign: 0.06 }}
        usableGroup={{ foreign: { desc: '', ratio: 0.06 } }}
        endpointMap={{}}
        autoGroups={[]}
        priceRate={1}
        usdExchangeRate={7}
        tokenUnit='M'
      />
    </QueryClientProvider>
  )

  expect(screen.getByText('95% off')).toBeVisible()
  expect(screen.queryByText('94% off')).not.toBeInTheDocument()
})
