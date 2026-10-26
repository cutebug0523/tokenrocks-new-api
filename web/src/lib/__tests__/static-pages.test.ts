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
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadStaticPages() {
  vi.resetModules()
  return import('@/lib/static-pages')
}

afterEach(() => {
  vi.resetModules()
})

describe('openStaticPage', () => {
  it('leaves the first route of a page load to the SPA', async () => {
    const staticPages = await loadStaticPages()
    const navigate = vi.fn()

    const result = staticPages.openStaticPage(
      { location: { href: '/pricing' }, preload: false },
      navigate
    )

    expect(result).toBeUndefined()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('loads the static document for in-app navigation after the first route', async () => {
    const staticPages = await loadStaticPages()
    const navigate = vi.fn()
    staticPages.markFirstRouteResolved()

    const result = staticPages.openStaticPage(
      { location: { href: '/pricing?group=国外特价' }, preload: false },
      navigate
    )

    expect(navigate).toHaveBeenCalledWith('/pricing?group=国外特价')
    expect(result).toBeInstanceOf(Promise)
  })

  it('ignores hover preloads so hovering a link does not leave the page', async () => {
    const staticPages = await loadStaticPages()
    const navigate = vi.fn()
    staticPages.markFirstRouteResolved()

    const result = staticPages.openStaticPage(
      { location: { href: '/' }, preload: true },
      navigate
    )

    expect(result).toBeUndefined()
    expect(navigate).not.toHaveBeenCalled()
  })
})
