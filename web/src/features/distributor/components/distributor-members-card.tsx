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
import { Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { TitledCard } from '@/components/ui/titled-card'
import { formatLocalCurrencyAmount } from '@/lib/currency'
import { formatDateTimeObject } from '@/lib/time'

import type { DistributorMember } from '../types'

interface DistributorMembersCardProps {
  members: DistributorMember[]
}

/** The distributor's own users with their top-ups and how much of it is spent. */
export function DistributorMembersCard(props: DistributorMembersCardProps) {
  const { t } = useTranslation()

  return (
    <TitledCard title={t('Your users')} icon={<Users />}>
      {props.members.length === 0 ? (
        <EmptyState title={t('No users yet')} />
      ) : (
        <StaticDataTable
          data={props.members}
          getRowKey={(member) => `${member.name}-${member.since}`}
          columns={[
            {
              id: 'name',
              header: t('Username'),
              cell: (member) => member.name,
            },
            {
              id: 'since',
              header: t('Counted since'),
              cell: (member) =>
                member.since === 0
                  ? t('Yourself')
                  : formatDateTimeObject(new Date(member.since * 1000)),
            },
            {
              id: 'paid',
              header: t('Total top-ups'),
              cell: (member) => formatLocalCurrencyAmount(member.paid),
            },
            {
              id: 'spent',
              header: t('Top-ups spent'),
              cell: (member) => formatLocalCurrencyAmount(member.spent),
            },
          ]}
        />
      )}
    </TitledCard>
  )
}
