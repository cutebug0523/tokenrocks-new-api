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
import { MessageCircleMore } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

// 11-03 起不放站长个人微信，全部引导进群：#wechat 链接会打开官网脚本 /_s/wechat.js 的群二维码卡片（群码在那里统一换）
export function SiteOwnerContact() {
  const { t } = useTranslation()

  return (
    <div className='flex w-full items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 shadow-xs dark:border-emerald-400/20 dark:bg-emerald-400/[0.06]'>
      <div
        aria-hidden='true'
        className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400'
      >
        <MessageCircleMore className='size-5' />
      </div>
      <div className='min-w-0 flex-1'>
        <p className='text-sm font-medium'>
          {t('Questions? Join our official group')}
        </p>
        <p className='text-muted-foreground mt-0.5 text-xs'>
          {t('Top-up, usage questions and outage notices are all in the group')}
        </p>
      </div>
      <Button
        variant='outline'
        size='sm'
        className='shrink-0'
        render={<a href='#wechat' />}
      >
        {t('Scan to join')}
      </Button>
    </div>
  )
}
