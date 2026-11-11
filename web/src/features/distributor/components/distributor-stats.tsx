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
import {
  Banknote,
  Clock,
  HandCoins,
  Landmark,
  Ticket,
  Users,
  Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { IconBadge, type IconBadgeTone } from '@/components/ui/icon-badge'
import { formatLocalCurrencyAmount } from '@/lib/currency'
import { formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { DistributorSelf } from '../types'

interface DistributorStatsProps {
  self: DistributorSelf
}

interface Tile {
  label: string
  value: string
  description: string
  icon: typeof Ticket
  tone: IconBadgeTone
}

export function DistributorStats(props: DistributorStatsProps) {
  const { t } = useTranslation()
  const stats = props.self.stats
  const thisMonth = stats?.months[0]
  const lastMonth = stats?.months[1]
  const children = stats?.children ?? []
  const payouts = stats?.payouts ?? []
  const activity: Tile[] = [
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
  ]
  const settlement: Tile[] = [
    {
      label: t('Total top-ups'),
      value: formatLocalCurrencyAmount(stats?.paid ?? 0),
      description: t('What your users have paid online'),
      icon: Wallet,
      tone: 'success',
    },
    {
      label: t('Pending commission'),
      value: formatLocalCurrencyAmount(stats?.pending ?? 0),
      description: t('On money your users have not spent yet'),
      icon: Clock,
      tone: 'chart-4',
    },
    {
      label: t('Withdrawable'),
      value: formatLocalCurrencyAmount(stats?.withdrawable ?? 0),
      description: t('On money your users have spent'),
      icon: HandCoins,
      tone: 'warning',
    },
    {
      label: t('Paid out'),
      value: formatLocalCurrencyAmount(stats?.withdrawn ?? 0),
      description:
        payouts.length > 0
          ? t('{{count}} payouts · last on {{date}}', {
              count: payouts.length,
              date: payouts.at(-1)?.date,
            })
          : t('No payouts yet'),
      icon: Landmark,
      tone: 'info',
    },
  ]

  return (
    <div className='space-y-2'>
      {[activity, settlement].map((tiles) => (
        <div
          key={tiles[0].label}
          className={cn(
            'grid grid-cols-2 divide-y rounded-lg border md:divide-x md:divide-y-0',
            tiles.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-4'
          )}
        >
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
      ))}
      {children.length > 0 && (
        <section
          aria-label={t('Sub-distributors')}
          className='rounded-lg border px-3 py-3 text-sm sm:px-5'
        >
          <h3 className='text-muted-foreground text-xs font-medium'>
            {t('Sub-distributors')}
          </h3>
          <ul className='mt-2 space-y-1'>
            {children.map((child) => (
              <li key={child.no}>
                {t(
                  'No. {{no}} · {{users}} users · top-ups {{money}} · your share {{earned}} from money spent, {{pending}} pending',
                  {
                    no: child.no,
                    users: child.users,
                    money: formatLocalCurrencyAmount(child.paid),
                    earned: formatLocalCurrencyAmount(child.earned),
                    pending: formatLocalCurrencyAmount(child.pending),
                  }
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {payouts.length > 0 && (
        <section
          aria-label={t('Payouts')}
          className='rounded-lg border px-3 py-3 text-sm sm:px-5'
        >
          <h3 className='text-muted-foreground text-xs font-medium'>
            {t('Payouts')}
          </h3>
          <ul className='mt-2 space-y-1 tabular-nums'>
            {payouts.map((payout) => (
              <li key={`${payout.date}-${payout.amount}`}>
                {`${payout.date} · ${formatLocalCurrencyAmount(payout.amount)}`}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className='text-muted-foreground text-xs'>
        {t(
          'Commission is {{rate}} of what your users pay online. It becomes withdrawable once they spend that money and stays pending until then. Bonus credit and redeemed codes are used first, and refunded money earns nothing. We pay by bank transfer at the start of each month.',
          { rate: formatPercent((props.self.commission_rate ?? 0.1) * 100) }
        )}
        {children.length > 0 &&
          ` ${t(
            "You also get {{rate}} of what your sub-distributors' users pay online, counted the same way.",
            {
              rate: formatPercent(
                (props.self.parent_commission_rate ?? 0.05) * 100
              ),
            }
          )}`}
      </p>
    </div>
  )
}
