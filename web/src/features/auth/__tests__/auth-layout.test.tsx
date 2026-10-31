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
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthLayout } from '../auth-layout'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: (props: {
    to: string
    className?: string
    children: React.ReactNode
  }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
}))

vi.mock('@/hooks/use-system-config', () => ({
  useSystemConfig: () => ({
    systemName: 'TokenRocks',
    logo: '/logo.png',
    loading: false,
  }),
}))

afterEach(() => {
  cleanup()
})

describe('AuthLayout', () => {
  it('shows the brand panel with selling points and the WeChat contact beside the form', () => {
    render(
      <AuthLayout>
        <form aria-label='Sign in form' />
      </AuthLayout>
    )

    const panel = screen.getByRole('complementary', {
      name: 'An LLM API platform built for teams',
    })
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3)
    expect(within(panel).getByText('bbslaoli')).toBeInTheDocument()
    expect(
      screen.getByRole('form', { name: 'Sign in form' })
    ).toBeInTheDocument()
  })

  it('keeps the site name linking back to the home page', () => {
    render(
      <AuthLayout>
        <form aria-label='Sign in form' />
      </AuthLayout>
    )

    expect(screen.getByRole('link', { name: /TokenRocks/ })).toHaveAttribute(
      'href',
      '/'
    )
  })
})
