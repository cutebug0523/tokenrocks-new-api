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
import { Loader2, Ticket } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TitledCard } from '@/components/ui/titled-card'
import { getPaymentIcon, submitPaymentForm } from '@/features/wallet/lib'
import { formatLocalCurrencyAmount } from '@/lib/currency'
import { handleServerError } from '@/lib/handle-server-error'
import { cn } from '@/lib/utils'

import { createDistributorOrder } from '../api'
import type { DistributorSelf } from '../types'

interface DistributorOrderCardProps {
  self: DistributorSelf
}

export function DistributorOrderCard(props: DistributorOrderCardProps) {
  const { t } = useTranslation()
  const faceValues = props.self.face_values ?? []
  const minCount = props.self.min_count ?? 10
  const maxCount = props.self.max_count ?? 500
  const [faceValue, setFaceValue] = useState(faceValues[0] ?? 0)
  const [count, setCount] = useState(String(Math.max(minCount, 50)))
  const [paying, setPaying] = useState<string | null>(null)

  const countNumber = Number(count)
  const countValid =
    Number.isInteger(countNumber) &&
    countNumber >= minCount &&
    countNumber <= maxCount
  const payMethods = props.self.pay_methods ?? []

  const pay = async (paymentMethod: string) => {
    setPaying(paymentMethod)
    try {
      const response = await createDistributorOrder({
        face_value: faceValue,
        count: countNumber,
        payment_method: paymentMethod,
      })
      if (response.message !== 'success' || !response.url || !response.data) {
        handleServerError(response, t('Payment request failed'))
        return
      }
      submitPaymentForm(response.url, response.data)
      toast.success(t('Redirecting to payment page...'))
    } catch (error) {
      handleServerError(error, t('Payment request failed'))
    } finally {
      setPaying(null)
    }
  }

  return (
    <TitledCard
      title={t('Buy redemption codes')}
      description={t(
        'Plain balance codes: no first top-up bonus, no tier bonus and no referral commission.'
      )}
      icon={<Ticket />}
    >
      <div className='space-y-5'>
        <div className='space-y-2.5'>
          <Label className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>
            {t('Face value')}
          </Label>
          <div className='grid grid-cols-3 gap-2 sm:gap-3'>
            {faceValues.map((value) => (
              <Button
                key={value}
                variant='outline'
                aria-pressed={faceValue === value}
                className={cn(
                  'h-12 text-base font-semibold',
                  faceValue === value
                    ? 'border-foreground bg-foreground/5 dark:border-foreground dark:bg-foreground/10'
                    : 'border-muted'
                )}
                onClick={() => setFaceValue(value)}
              >
                {formatLocalCurrencyAmount(value)}
              </Button>
            ))}
          </div>
        </div>

        <div className='space-y-2.5'>
          <Label
            htmlFor='distributor-count'
            className='text-muted-foreground text-xs font-medium tracking-wider uppercase'
          >
            {t('Quantity')}
          </Label>
          <div className='grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2'>
            <Input
              id='distributor-count'
              type='number'
              inputMode='numeric'
              min={minCount}
              max={maxCount}
              value={count}
              aria-invalid={!countValid}
              aria-describedby='distributor-count-hint'
              onChange={(event) => setCount(event.target.value)}
              className='h-10 text-base'
            />
            <div className='bg-muted/30 flex h-10 items-center gap-2 rounded-md border px-3 text-sm'>
              <span className='text-muted-foreground'>{t('Total')}</span>
              <span className='font-semibold'>
                {countValid
                  ? formatLocalCurrencyAmount(faceValue * countNumber)
                  : '-'}
              </span>
            </div>
          </div>
          <p
            id='distributor-count-hint'
            className={cn(
              'text-xs',
              countValid ? 'text-muted-foreground' : 'text-destructive'
            )}
          >
            {t('Buy between {{min}} and {{max}} codes at a time', {
              min: minCount,
              max: maxCount,
            })}
          </p>
        </div>

        <div className='space-y-2.5'>
          <Label className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>
            {t('Payment Method')}
          </Label>
          {payMethods.length > 0 ? (
            <div className='grid grid-cols-2 gap-2 sm:gap-3'>
              {payMethods.map((method) => (
                <Button
                  key={method.type}
                  variant='outline'
                  disabled={!countValid || faceValue <= 0 || paying !== null}
                  onClick={() => pay(method.type)}
                  className='h-12 justify-start gap-2'
                >
                  {paying === method.type ? (
                    <Loader2 className='h-4 w-4 animate-spin' aria-hidden />
                  ) : (
                    getPaymentIcon(
                      method.type,
                      'h-4 w-4',
                      method.icon,
                      method.name
                    )
                  )}
                  <span className='truncate'>{method.name}</span>
                </Button>
              ))}
            </div>
          ) : (
            <p className='text-muted-foreground text-sm'>
              {t('Online payment is not available right now')}
            </p>
          )}
          <p className='text-muted-foreground text-xs'>
            {t(
              'After paying, come back to this page and download the codes from the order list.'
            )}
          </p>
        </div>
      </div>
    </TitledCard>
  )
}
