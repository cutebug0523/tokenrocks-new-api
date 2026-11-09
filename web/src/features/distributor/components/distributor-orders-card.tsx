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
import { Download, Loader2, ReceiptText, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { TitledCard } from '@/components/ui/titled-card'
import { formatLocalCurrencyAmount } from '@/lib/currency'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { formatDateTimeObject } from '@/lib/time'

import { getDistributorOrderCodes } from '../api'
import type { DistributorOrder } from '../types'

interface DistributorOrdersCardProps {
  orders: DistributorOrder[]
  refreshing: boolean
  onRefresh: () => void
}

/** Saves one paid order's codes as a txt file, one code per line. */
async function downloadOrderCodes(orderId: number): Promise<void> {
  const response = requireServerSuccess(await getDistributorOrderCodes(orderId))
  const batch = response.data
  if (!batch) return
  const blob = new Blob([`${batch.codes.join('\n')}\n`], {
    type: 'text/plain;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${batch.batch_name}.txt`
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function DistributorOrdersCard(props: DistributorOrdersCardProps) {
  const { t } = useTranslation()
  const [downloading, setDownloading] = useState<number | null>(null)

  const download = async (orderId: number) => {
    setDownloading(orderId)
    try {
      await downloadOrderCodes(orderId)
    } catch (error) {
      handleServerError(error)
    } finally {
      setDownloading(null)
    }
  }

  return (
    <TitledCard
      title={t('Code orders')}
      icon={<ReceiptText />}
      action={
        <Button
          variant='outline'
          size='sm'
          onClick={props.onRefresh}
          disabled={props.refreshing}
        >
          <RefreshCw
            className={props.refreshing ? 'animate-spin' : undefined}
            aria-hidden
          />
          {t('Refresh')}
        </Button>
      }
    >
      {props.orders.length === 0 ? (
        <EmptyState title={t('No code orders yet')} />
      ) : (
        <StaticDataTable
          data={props.orders}
          getRowKey={(order) => order.id}
          columns={[
            {
              id: 'codes',
              header: t('Redemption codes'),
              cell: (order) =>
                t('{{face}} × {{count}}', {
                  face: formatLocalCurrencyAmount(order.face_value),
                  count: order.count,
                }),
            },
            {
              id: 'amount',
              header: t('Amount'),
              cell: (order) => formatLocalCurrencyAmount(order.money),
            },
            {
              id: 'status',
              header: t('Status'),
              cell: (order) =>
                order.status === 'success' ? (
                  <div className='flex items-center gap-2'>
                    <StatusBadge
                      label={t('Paid')}
                      variant='success'
                      copyable={false}
                    />
                    <Button
                      variant='outline'
                      size='sm'
                      disabled={downloading !== null}
                      onClick={() => download(order.id)}
                    >
                      {downloading === order.id ? (
                        <Loader2 className='animate-spin' aria-hidden />
                      ) : (
                        <Download aria-hidden />
                      )}
                      {t('Download codes')}
                    </Button>
                  </div>
                ) : (
                  <StatusBadge
                    label={t('Unpaid')}
                    variant='neutral'
                    copyable={false}
                  />
                ),
            },
            {
              id: 'time',
              header: t('Time'),
              cell: (order) =>
                formatDateTimeObject(new Date(order.create_time * 1000)),
            },
          ]}
        />
      )}
    </TitledCard>
  )
}
