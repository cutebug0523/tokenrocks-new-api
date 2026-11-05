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
import { useMutation } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { AuthLayout } from '@/features/auth/auth-layout'
import { handleServerError } from '@/lib/handle-server-error'

import { approveHelperLogin } from './api'
import { type HelperLoginSearch, helperCallbackUrl } from './lib/helper-login'

// Matches service.AccessTokenDefaultExpiryDays, the helper token's lifetime.
const HELPER_ACCESS_DAYS = 30

export function HelperLogin(props: { search: HelperLoginSearch }) {
  const { t } = useTranslation()
  const [approved, setApproved] = useState(false)
  const approve = useMutation({
    mutationFn: () => approveHelperLogin(props.search.code_challenge),
    onSuccess: (code) => {
      setApproved(true)
      window.location.assign(
        helperCallbackUrl(props.search.port, { code, state: props.search.state })
      )
    },
    onError: (error) => handleServerError(error, t('Authorization failed')),
  })
  // A framed copy could be used to trick the click, so it offers nothing.
  const usable =
    window.self === window.top &&
    Boolean(props.search.code_challenge && props.search.state && props.search.port)

  let body = (
    <p className='text-muted-foreground text-center text-sm'>
      {t('This sign-in link is incomplete. Click Sign in in the helper again.')}
    </p>
  )
  if (usable && approved) {
    body = (
      <p className='text-center text-sm'>
        {t('Authorized. You can go back to the helper now.')}
      </p>
    )
  } else if (usable) {
    body = (
      <div className='space-y-4 text-sm'>
        <p>{t('The helper will be able to:')}</p>
        <ul className='list-disc space-y-1 pl-5'>
          <li>{t('See your account, balance, usage and API keys')}</li>
          <li>{t('Read API keys to set them up in AI apps on this computer')}</li>
          <li>{t('Create new API keys')}</li>
          <li>{t('Redeem top-up codes')}</li>
        </ul>
        <p className='text-muted-foreground'>
          {t(
            'Access lasts {{days}} days. You can revoke it anytime in Security & Access → Access tokens.',
            { days: HELPER_ACCESS_DAYS }
          )}
        </p>
        <p className='text-muted-foreground'>
          {t('Only authorize if you just clicked Sign in in the helper.')}
        </p>
        <div className='flex gap-3 pt-2'>
          <Button
            className='flex-1'
            disabled={approve.isPending}
            onClick={() => approve.mutate()}
          >
            {t('Authorize')}
          </Button>
          <Button
            variant='outline'
            className='flex-1'
            disabled={approve.isPending}
            onClick={() =>
              window.location.assign(
                helperCallbackUrl(props.search.port, {
                  error: 'access_denied',
                  state: props.search.state,
                })
              )
            }
          >
            {t('Cancel')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <AuthLayout>
      <div className='w-full space-y-6'>
        <div className='flex flex-col items-center space-y-4 text-center'>
          <div className='bg-muted flex h-16 w-16 items-center justify-center rounded-2xl'>
            <KeyRound className='h-8 w-8' aria-hidden='true' />
          </div>
          <h2 className='text-2xl font-semibold tracking-tight'>
            {t('Authorize TokenRocks Helper')}
          </h2>
        </div>
        {body}
      </div>
    </AuthLayout>
  )
}
