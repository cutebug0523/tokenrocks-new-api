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
import { Banknote, HandCoins, Ticket, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { IconBadge, type IconBadgeTone } from '@/components/ui/icon-badge'
import { formatLocalCurrencyAmount } from '@/lib/currency'
import { formatPercent } from '@/lib/format'

import type { DistributorSelf } from '../types'

interface DistributorStatsProps {
  self: DistributorSelf
}

export function DistributorStats(props: DistributorStatsProps) {
  const { t } = useTranslation()
  const stats = props.self.stats
  const thisMonth = stats?.months[0]
  const lastMonth = stats?.months[1]
  const tiles: {
    label: string
    value: string
    description: string
    icon: typeof Ticket
    tone: IconBadgeTone
  }[] = [
    {
      label: t('Codes redeemed'),
      value: t('{{redeemed}} / {{total}}', {
        redeemed: stats?.codes_redeemed ?? 0,
        total: stats?.codes_total ?? 0,
      }),
      description: t('Redeemed / all your codes'),
      icon: Ticket,
      tone: 'info',
    },
    {
      label: t('Your users'),
      value: String(stats?.users ?? 0),
      description: t('Users whose first redeemed code is yours'),
      icon: Users,
      tone: 'chart-4',
    },
    {
      label: t('Top-ups this month'),
      value: formatLocalCurrencyAmount(thisMonth?.money ?? 0),
      description: t('{{count}} orders · last month {{amount}}', {
        count: thisMonth?.count ?? 0,
        amount: formatLocalCurrencyAmount(lastMonth?.money ?? 0),
      }),
      icon: Banknote,
      tone: 'success',
    },
    {
      label: t('Commission this month'),
      value: formatLocalCurrencyAmount(thisMonth?.commission ?? 0),
      description: t('Last month {{amount}}', {
        amount: formatLocalCurrencyAmount(lastMonth?.commission ?? 0),
      }),
      icon: HandCoins,
      tone: 'warning',
    },
  ]

  return (
    <div className='space-y-2'>
      <div className='grid grid-cols-2 divide-y rounded-lg border md:grid-cols-4 md:divide-x md:divide-y-0'>
        {tiles.map((item) => (
          <div key={item.label} className='min-w-0 px-3 py-3 sm:px-5 sm:py-4'>
            <div className='flex items-center gap-2'>
              <IconBadge tone={item.tone} size='stat'>
                <item.icon />
              </IconBadge>
              <div className='text-muted-foreground truncate text-xs font-medium'>
                {item.label}
              </div>
            </div>
            <div className='text-foreground mt-2 font-mono text-lg font-bold tabular-nums sm:text-2xl'>
              {item.value}
            </div>
            <div className='text-muted-foreground mt-1 text-xs'>
              {item.description}
            </div>
          </div>
        ))}
      </div>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Commission is {{rate}} of what your users pay online, paid in cash at the start of each month. Refunded orders are deducted at settlement.',
          { rate: formatPercent((props.self.commission_rate ?? 0.1) * 100) }
        )}
      </p>
    </div>
  )
}
