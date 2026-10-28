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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'

import { ApiKeyGroupCell } from '../components/api-key-group-cell'
import { GroupRatioBadge } from '../components/auto-group-visuals'

// A group's ratio is only its default: group_model_ratio prices some models in
// the same group higher, so the key pages must not show it as the group's price.

afterEach(cleanup)

it('GroupRatioBadge with a numeric group ratio renders nothing', () => {
  const { container } = render(<GroupRatioBadge ratio={0.05} />)

  expect(container).toBeEmptyDOMElement()
})

it('GroupRatioBadge for the auto group still shows the auto label', () => {
  render(<GroupRatioBadge ratio='auto' isAuto shouldReduceMotion />)

  expect(screen.getByText('Auto')).toBeInTheDocument()
})

it('ApiKeyGroupCell for a named group shows the group without its ratio', () => {
  render(
    <TooltipProvider>
      <ApiKeyGroupCell
        crossGroupRetry={false}
        group='国模特价'
        ratio={0.05}
        shouldReduceMotion
      />
    </TooltipProvider>
  )

  expect(screen.getByText('国模特价')).toBeInTheDocument()
  expect(screen.queryByText('0.05x')).not.toBeInTheDocument()
})
