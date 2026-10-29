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
import { Link } from '@tanstack/react-router'
import { CalendarCheck } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { getCheckinStatus, performCheckin } from '@/features/profile/api'
import { useStatus } from '@/hooks/use-status'
import { getSelf } from '@/lib/api'
import { formatQuotaWithCurrency } from '@/lib/currency'
import dayjs from '@/lib/dayjs'
import { handleServerError } from '@/lib/handle-server-error'
import { createServerError } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

// TokenRocks: users land on the overview after signing in and rarely open the
// profile page, so check-in also sits next to the balance it adds to. The
// calendar card on the profile page shares this query and handles Turnstile,
// so with Turnstile on this button links there instead.
export function DailyCheckinButton() {
  const { t } = useTranslation()
  const { status } = useStatus()
  const setUser = useAuthStore((s) => s.auth.setUser)
  const [submitting, setSubmitting] = useState(false)
  const enabled = status?.checkin_enabled === true
  const month = dayjs().format('YYYY-MM')

  /* eslint-disable @tanstack/query/exhaustive-deps */
  const checkinQuery = useQuery({
    queryKey: ['checkin-status', month],
    queryFn: async () => {
      const res = await getCheckinStatus(month)
      if (res.success && res.data) return res.data
      throw createServerError(res, t('Failed to fetch checkin status'))
    },
    enabled,
    staleTime: 30000,
  })
  /* eslint-enable @tanstack/query/exhaustive-deps */

  if (!enabled || !checkinQuery.data) return null

  // The award shows in the toast and on the profile calendar; the label stays
  // short so the wallet button keeps its row.
  if (checkinQuery.data.stats?.checked_in_today) {
    return (
      <Button variant='outline' disabled>
        <CalendarCheck data-icon='inline-start' />
        {t('Checked in')}
      </Button>
    )
  }

  if (status?.turnstile_check && status?.turnstile_site_key) {
    return (
      <Button variant='outline' render={<Link to='/profile' />}>
        <CalendarCheck data-icon='inline-start' />
        {t('Check in now')}
      </Button>
    )
  }

  const checkin = async () => {
    setSubmitting(true)
    try {
      const res = await performCheckin()
      if (!res.success || !res.data) {
        handleServerError(res, t('Check-in failed'))
        return
      }
      toast.success(
        `${t('Check-in successful! Received')} ${formatQuotaWithCurrency(res.data.quota_awarded)}`
      )
      await checkinQuery.refetch()
      const self = await getSelf()
      if (self.success && self.data) setUser(self.data)
    } catch (error) {
      handleServerError(error, t('Check-in failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Button variant='outline' disabled={submitting} onClick={checkin}>
      <CalendarCheck data-icon='inline-start' />
      {submitting ? t('Loading...') : t('Check in now')}
    </Button>
  )
}
