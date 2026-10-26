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
/**
 * Pages served as static documents by nginx in production: the marketing
 * home page (`/`), the model price list (`/pricing`) and the model detail
 * pages (`/pricing/<model>`).
 *
 * In-app navigation to them must load the real document instead of the SPA
 * route. The first route resolution of a page load is left to the SPA, so a
 * direct load without nginx (local dev, other deployments) still renders the
 * SPA page instead of reloading forever. Hover/intent preloads are ignored.
 */
let firstRouteResolved = false

export function markFirstRouteResolved(): void {
  firstRouteResolved = true
}

type StaticPageLoad = {
  location: { href: string }
  preload: boolean
}

export function openStaticPage(
  load: StaticPageLoad,
  navigate: (href: string) => void = (href) => window.location.assign(href)
): Promise<never> | undefined {
  if (!firstRouteResolved || load.preload) return undefined
  navigate(load.location.href)
  // Keep the router pending while the browser loads the static document.
  return new Promise<never>(() => {})
}
