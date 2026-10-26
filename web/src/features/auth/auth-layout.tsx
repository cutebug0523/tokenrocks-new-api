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
import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Skeleton } from '@/components/ui/skeleton'
import { useSystemConfig } from '@/hooks/use-system-config'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  const { t } = useTranslation()
  const { systemName, logo, loading } = useSystemConfig()
  const sellingPoints = [
    t('One API key for DeepSeek, Qwen, Claude, GPT and other leading models'),
    t(
      'Prices from 5% of the official rate, pay as you go, and your balance never expires'
    ),
    t(
      'Compatible with OpenAI and Anthropic APIs, so your existing tools just work'
    ),
  ]

  return (
    <div className='relative grid min-h-svh max-w-none lg:grid-cols-2'>
      <Link
        to='/'
        className='lg:text-primary-foreground absolute top-4 left-4 z-10 flex items-center gap-2 transition-opacity hover:opacity-80 sm:top-8 sm:left-8'
      >
        <div className='relative h-8 w-8'>
          {loading ? (
            <Skeleton className='absolute inset-0 rounded-full' />
          ) : (
            <img
              src={logo}
              alt={t('Logo')}
              className='h-8 w-8 rounded-full object-cover'
            />
          )}
        </div>
        {loading ? (
          <Skeleton className='h-6 w-24' />
        ) : (
          <h1 className='text-xl font-medium'>{systemName}</h1>
        )}
      </Link>
      <aside
        aria-labelledby='auth-brand-title'
        className='bg-primary text-primary-foreground hidden flex-col justify-center gap-10 px-12 pt-24 pb-12 lg:flex'
      >
        <div className='flex max-w-md flex-col gap-6'>
          <h2
            id='auth-brand-title'
            className='text-4xl leading-tight font-bold tracking-tight'
          >
            {t('An LLM API platform built for teams')}
          </h2>
          <ul className='flex flex-col gap-3 text-base'>
            {sellingPoints.map((point) => (
              <li key={point} className='flex items-start gap-3'>
                <Check className='mt-1 size-4 shrink-0' aria-hidden='true' />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className='text-sm opacity-85'>
          {t('Site owner WeChat:')}{' '}
          <span className='font-mono font-semibold'>cutebug0523</span>
        </p>
      </aside>
      <div className='container flex items-center pt-16 sm:pt-0'>
        <div className='mx-auto flex w-full flex-col justify-center space-y-2 px-4 py-8 sm:w-[480px] sm:p-8'>
          {children}
        </div>
      </div>
    </div>
  )
}
