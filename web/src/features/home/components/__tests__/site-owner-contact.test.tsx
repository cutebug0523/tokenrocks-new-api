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
import { describe, expect, it } from 'vitest'

import { SiteOwnerContact } from '../site-owner-contact'

describe('site owner contact', () => {
  it('guides users into the official group instead of a personal WeChat', () => {
    render(<SiteOwnerContact />)

    expect(screen.getByText('Questions? Join our official group')).toBeVisible()
    expect(screen.queryByText('bbslaoli')).not.toBeInTheDocument()
  })

  it('opens the group QR card through the #wechat link', () => {
    render(<SiteOwnerContact />)

    expect(
      screen.getByRole('button', { name: 'Scan to join' })
    ).toHaveAttribute('href', '#wechat')
  })
})
