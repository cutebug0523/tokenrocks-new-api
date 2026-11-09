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
import { useQuery } from '@tanstack/react-query'
import { Store } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { SectionPageLayout } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getDistributorSelf } from './api'
import { DistributorOrderCard } from './components/distributor-order-card'
import { DistributorOrdersCard } from './components/distributor-orders-card'
import { DistributorStats } from './components/distributor-stats'

/**
 * Hidden page for distributors (not in the menu; fx.tokenrocks.ai redirects
 * here). The server decides who is a distributor.
 */
export function Distributor() {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['distributor-self'],
    queryFn: async () => requireServerSuccess(await getDistributorSelf()).data,
    // Payment opens in a new tab; coming back should show the paid order.
    refetchOnWindowFocus: true,
  })
  const self = query.data

  let content: ReactNode
  if (query.isLoading) {
    content = <LoadingState />
  } else if (!self?.enabled) {
    content = (
      <EmptyState
        icon={Store}
        title={t('This page is only for distributors')}
        description={t(
          'Contact us in the official group to become a distributor.'
        )}
        bordered
      />
    )
  } else {
    content = (
      <>
        <DistributorStats self={self} />
        <DistributorOrderCard self={self} />
        <DistributorOrdersCard
          orders={self.orders ?? []}
          refreshing={query.isFetching}
          onRefresh={() => query.refetch()}
        />
      </>
    )
  }

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        {self?.enabled
          ? t('Distributor No. {{no}}', { no: self.no })
          : t('Distributor')}
      </SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='mx-auto flex w-full max-w-5xl flex-col gap-4 sm:gap-5'>
          {content}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
