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
import { z } from 'zod'

// The helper opens this page with a PKCE S256 challenge, its own state and the
// port of its loopback listener (RFC 8252, RFC 7636).
export const helperLoginSearchSchema = z.object({
  code_challenge: z.coerce
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .catch(''),
  state: z.coerce
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .catch(''),
  port: z.coerce.number().int().min(1024).max(65535).catch(0),
})

export type HelperLoginSearch = z.infer<typeof helperLoginSearchSchema>

// helperCallbackUrl is the helper's loopback listener; the host is fixed so
// the page can only hand the code to this computer.
export function helperCallbackUrl(
  port: number,
  params: Record<string, string>
): string {
  return `http://127.0.0.1:${port}/callback?${new URLSearchParams(params)}`
}
