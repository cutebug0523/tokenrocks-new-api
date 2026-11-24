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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HandCoins, Landmark } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { TitledCard } from '@/components/ui/titled-card'
import { formatLocalCurrencyAmount } from '@/lib/currency'
import { formatTimestampToDate } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'

import {
  getDistributorWithdrawals,
  requestDistributorWithdraw,
  resolveDistributorWithdrawal,
} from '../api'
import type { DistributorSelf, DistributorWithdrawal } from '../types'

const day = (ts: number) => formatTimestampToDate(ts).slice(0, 10)

function useStatusText() {
  const { t } = useTranslation()
  return (w: DistributorWithdrawal) => {
    let status = t('Rejected')
    if (w.status === 'pending') status = t('Waiting to be paid')
    if (w.status === 'paid') {
      status = t('Paid on {{date}}', { date: day(w.done_time) })
    }
    return w.note ? `${status} · ${w.note}` : status
  }
}

/** The distributor's own withdrawal: one request at a time, all withdrawable. */
export function DistributorWithdrawCard(props: { self: DistributorSelf }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const statusText = useStatusText()
  const withdrawable = props.self.stats?.withdrawable ?? 0
  const min = props.self.withdraw_min ?? 0
  const withdrawals = props.self.withdrawals ?? []
  const pending = withdrawals.find((w) => w.status === 'pending')
  const [account, setAccount] = useState(props.self.withdraw_account ?? '')
  const enough = withdrawable > 0 && withdrawable >= min

  const mutation = useMutation({
    mutationFn: async () =>
      requireServerSuccess(await requestDistributorWithdraw(account.trim())),
    onSuccess: () => {
      toast.success(t('Withdrawal requested'))
      queryClient.invalidateQueries({ queryKey: ['distributor-self'] })
    },
    onError: (error: Error) => handleServerError(error),
  })

  return (
    <TitledCard
      title={t('Withdraw')}
      description={t(
        'Once {{min}} or more is withdrawable you can withdraw all of it. We pay by bank transfer within 3 working days.',
        { min: formatLocalCurrencyAmount(min) }
      )}
      icon={<HandCoins />}
    >
      <div className='space-y-4'>
        {pending ? (
          <p className='bg-muted/30 rounded-md border px-3 py-2 text-sm'>
            {t('{{amount}} requested on {{date}}, waiting to be paid', {
              amount: formatLocalCurrencyAmount(pending.amount),
              date: day(pending.create_time),
            })}
          </p>
        ) : (
          <div className='space-y-2.5'>
            <Label
              htmlFor='distributor-withdraw-account'
              className='text-muted-foreground text-xs font-medium tracking-wider uppercase'
            >
              {t('Where should we pay you')}
            </Label>
            <Textarea
              id='distributor-withdraw-account'
              maxLength={200}
              rows={2}
              value={account}
              placeholder={t('Name, and Alipay account or bank card number')}
              onChange={(event) => setAccount(event.target.value)}
            />
            <div className='flex flex-wrap items-center gap-3'>
              <Button
                disabled={!enough || !account.trim() || mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                {t('Withdraw {{amount}}', {
                  amount: formatLocalCurrencyAmount(withdrawable),
                })}
              </Button>
              {!enough && (
                <span className='text-muted-foreground text-xs'>
                  {t('You can withdraw once at least {{min}} is withdrawable', {
                    min: formatLocalCurrencyAmount(min),
                  })}
                </span>
              )}
            </div>
          </div>
        )}
        {withdrawals.length > 0 && (
          <ul
            aria-label={t('Withdrawal requests')}
            className='space-y-1 text-sm tabular-nums'
          >
            {withdrawals.map((w) => (
              <li key={w.id}>
                {`${day(w.create_time)} · ${formatLocalCurrencyAmount(w.amount)} · ${statusText(w)}`}
              </li>
            ))}
          </ul>
        )}
      </div>
    </TitledCard>
  )
}

/** Admin: every distributor's requests; pay by bank transfer, then mark paid. */
export function DistributorWithdrawalsAdminCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const statusText = useStatusText()
  const [target, setTarget] = useState<{
    w: DistributorWithdrawal
    action: 'paid' | 'reject'
  } | null>(null)
  const [note, setNote] = useState('')
  const query = useQuery({
    queryKey: ['distributor-withdrawals'],
    queryFn: async () =>
      requireServerSuccess(await getDistributorWithdrawals()).data ?? [],
  })
  const mutation = useMutation({
    mutationFn: async () => {
      if (!target) return
      requireServerSuccess(
        await resolveDistributorWithdrawal(
          target.w.id,
          target.action,
          note.trim()
        )
      )
    },
    onError: (error: Error) => handleServerError(error),
    // Also on failure: "already handled" means the list is stale.
    onSettled: () => {
      setTarget(null)
      queryClient.invalidateQueries({ queryKey: ['distributor-withdrawals'] })
      queryClient.invalidateQueries({ queryKey: ['distributor-self'] })
    },
  })
  const list = query.data ?? []
  const targetParams = {
    no: target?.w.distributor_no,
    amount: formatLocalCurrencyAmount(target?.w.amount ?? 0),
  }
  let listContent: ReactNode = null
  if (query.isError && !query.data) {
    listContent = <ErrorState onRetry={() => query.refetch()} />
  } else if (list.length === 0) {
    listContent = (
      <p className='text-muted-foreground text-sm'>
        {t('No withdrawal requests')}
      </p>
    )
  }
  const open = (w: DistributorWithdrawal, action: 'paid' | 'reject') => {
    setNote('')
    setTarget({ w, action })
  }

  return (
    <TitledCard
      title={t('Withdrawal requests')}
      description={t(
        'Only the super admin sees this. Pay by bank transfer first, then mark it paid. Rejecting puts the money back into withdrawable.'
      )}
      icon={<Landmark />}
    >
      {listContent ?? (
        <ul className='divide-y text-sm'>
          {list.map((w) => (
            <li key={w.id} className='space-y-1 py-2'>
              <div className='font-medium tabular-nums'>
                {t('No. {{no}} · {{amount}} · requested {{date}}', {
                  no: w.distributor_no,
                  amount: formatLocalCurrencyAmount(w.amount),
                  date: formatTimestampToDate(w.create_time),
                })}
              </div>
              <div className='break-all whitespace-pre-wrap select-all'>
                {w.account}
              </div>
              {w.status === 'pending' ? (
                <div className='flex gap-2'>
                  <Button size='sm' onClick={() => open(w, 'paid')}>
                    {t('Mark paid')}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => open(w, 'reject')}
                  >
                    {t('Reject')}
                  </Button>
                </div>
              ) : (
                <div className='text-muted-foreground'>{statusText(w)}</div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(next) => !next && setTarget(null)}
        title={
          target?.action === 'paid'
            ? t('Mark this withdrawal paid?')
            : t('Reject this withdrawal?')
        }
        desc={
          target?.action === 'paid'
            ? t(
                'Only after the bank transfer to No. {{no}} for {{amount}} has gone through.',
                targetParams
              )
            : t(
                '{{amount}} goes back to No. {{no}}, who can request again.',
                targetParams
              )
        }
        destructive={target?.action === 'reject'}
        isLoading={mutation.isPending}
        handleConfirm={() => mutation.mutate()}
      >
        <Input
          aria-label={t('Note, the distributor sees it (optional)')}
          placeholder={t('Note, the distributor sees it (optional)')}
          maxLength={200}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </ConfirmDialog>
    </TitledCard>
  )
}
