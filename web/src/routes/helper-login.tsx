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
import { createFileRoute, redirect } from '@tanstack/react-router'

import { HelperLogin } from '@/features/security/helper-login'
import { helperLoginSearchSchema } from '@/features/security/lib/helper-login'
import { resolveAuthentication } from '@/lib/auth-session'
import { useAuthStore } from '@/stores/auth-store'

// Outside /_authenticated so it uses the sign-in layout, with the same guard.
export const Route = createFileRoute('/helper-login')({
  validateSearch: helperLoginSearchSchema,
  beforeLoad: async ({ location }) => {
    await resolveAuthentication()
    const { auth } = useAuthStore.getState()
    if (!auth.user || !auth.accessToken) {
      throw redirect({ to: '/sign-in', search: { redirect: location.href } })
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  return <HelperLogin search={Route.useSearch()} />
}
