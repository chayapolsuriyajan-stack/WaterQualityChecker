import { useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { Sidebar, type ViewId } from './Sidebar'

interface RailHoverPanelProps {
  view: ViewId
  onChange: (view: ViewId) => void
  className?: string
}

/**
 * Collapsed icon-only `Sidebar` that expands into the full labeled sidebar
 * on hover — the familiar "VS Code / Notion" rail pattern: rest your mouse
 * over it and it grows wider with text; move away and it shrinks back.
 * Applies at every non-phone breakpoint (see App.tsx).
 *
 * Renders exactly ONE `Sidebar` and just flips its `collapsed` prop — the
 * rail's own width transition (see Sidebar.tsx) is what makes this read as
 * smooth in-place growth. An earlier version rendered a second, separate
 * full-width `Sidebar` as an overlay that slid on top of the collapsed one;
 * that looked like a panel awkwardly appearing over the rail rather than the
 * rail itself expanding, since they were two unrelated DOM subtrees.
 *
 * `expanded` is plain mouseenter/mouseleave (mouse/trackpad) plus
 * focus/blur (keyboard tabbing into the rail) — no click-to-pin: nav icons
 * already navigate immediately on click/tap, so there's no separate
 * "tap to expand" gesture to layer on top without conflicting with that.
 * Touch devices, which have no hover, keep the plain always-tap-to-navigate
 * icon rail (same as before this component existed).
 */
export function RailHoverPanel({ view, onChange, className }: RailHoverPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={containerRef}
      className={cn('relative', className)}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node)) setExpanded(false)
      }}
    >
      <Sidebar view={view} onChange={onChange} collapsed={!expanded} />
    </div>
  )
}
