import { useEffect, useRef, useState } from 'react'
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
 * `expanded` is the OR of two sources: `hovering` (plain mouseenter/
 * mouseleave — the primary desktop/trackpad interaction) and `pinned`
 * (toggled by clicking the rail, the fallback for touch devices which have
 * no hover). Clicking a nav item always navigates immediately and un-pins,
 * exactly like the plain rail always has.
 */
export function RailHoverPanel({ view, onChange, className }: RailHoverPanelProps) {
  const [hovering, setHovering] = useState(false)
  const [pinned, setPinned] = useState(false)
  const expanded = hovering || pinned
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pinned) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(false)
    }
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPinned(false)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [pinned])

  const handleNavigate = (nextView: ViewId) => {
    onChange(nextView)
    setPinned(false)
  }

  return (
    <div
      ref={containerRef}
      className={cn('relative', className)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setHovering(true)}
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node)) setHovering(false)
      }}
      onClick={() => setPinned((v) => !v)}
    >
      <Sidebar view={view} onChange={handleNavigate} collapsed={!expanded} />
    </div>
  )
}
