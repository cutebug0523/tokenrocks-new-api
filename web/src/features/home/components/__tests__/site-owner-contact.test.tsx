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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { copyToClipboard } from '@/lib/copy-to-clipboard'

import { SiteOwnerContact } from '../site-owner-contact'

vi.mock('@/lib/copy-to-clipboard', () => ({
  copyToClipboard: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(copyToClipboard).mockReset().mockResolvedValue(true)
})

describe('site owner contact', () => {
  it('shows the WeChat contact and guidance together', () => {
    render(<SiteOwnerContact />)

    expect(screen.getByText('Site owner WeChat:')).toBeVisible()
    expect(screen.getByText('cutebug0523')).toBeVisible()
    expect(screen.getByText('Questions? Add me on WeChat')).toBeVisible()
  })

  it('copies the displayed WeChat ID from the accessible copy button', async () => {
    const user = userEvent.setup()
    render(<SiteOwnerContact />)

    await user.click(screen.getByRole('button', { name: 'Copy WeChat ID' }))

    expect(copyToClipboard).toHaveBeenCalledWith('cutebug0523')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible()
  })
})
