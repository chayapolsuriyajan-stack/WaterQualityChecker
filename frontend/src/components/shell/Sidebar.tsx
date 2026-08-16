import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Droplets, Gauge, History, SlidersHorizontal } from 'lucide-react'
import { motion } from 'motion/react'
import { TourHelpButton } from '@/components/shell/TourHelpButton'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/strings'
import { LanguageSwitcher } from './LanguageSwitcher'
import { ThemeToggle } from './ThemeToggle'
import { UserBadge } from './UserBadge'

export type ViewId = 'dashboard' | 'calibration' | 'history'

export interface NavItem {
  id: ViewId
  labelKey: MessageKey
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: Gauge },
  { id: 'calibration', labelKey: 'nav.calibration', icon: SlidersHorizontal },
  { id: 'history', labelKey: 'nav.history', icon: History },
]

interface SidebarProps {
  view: ViewId
  onChange: (view: ViewId) => void
  /**
   * Icon-only collapsed rail. Unlike a hard show/hide, the width itself
   * transitions (`transition-[width]` below) and every label is always
   * present in the DOM, revealed via a `max-width`+opacity transition on its
   * own wrapper — so toggling this prop reads as the SAME rail smoothly
   * growing/shrinking in place, not content popping in and out. This matters
   * because `RailHoverPanel` renders exactly one `Sidebar` and just flips
   * this prop on hover — two separately-rendered Sidebars (a static
   * collapsed rail plus a second full one sliding on top) is what used to
   * happen here, and looked like a panel awkwardly overlaying the rail
   * instead of the rail itself expanding.
   */
  collapsed?: boolean
  className?: string
}

/** A label that reveals via width/opacity instead of mounting/unmounting, so the rail's own width transition and its text stay in sync. */
function RevealLabel({ collapsed, className, children }: { collapsed: boolean; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'overflow-hidden whitespace-nowrap transition-all duration-300 ease-out motion-reduce:transition-none',
        collapsed ? 'max-w-0 opacity-0' : 'max-w-[10rem] opacity-100',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Fixed left navigation rail. `collapsed` drives an icon-only vs. full-width layout, transitioning smoothly between them (see `RailHoverPanel`, which hovers this between the two). */
export function Sidebar({ view, onChange, collapsed = false, className }: SidebarProps) {
  const { t } = useT()

  return (
    <aside
      className={cn(
        'flex h-full flex-col overflow-hidden border-r border-sidebar-border bg-sidebar/92 text-sidebar-foreground backdrop-blur-xl',
        'transition-[width,padding] duration-300 ease-out motion-reduce:transition-none',
        collapsed ? 'w-[72px] items-center px-2 py-4' : 'w-64 items-stretch px-4 py-5',
        className,
      )}
    >
      {/* gap only when expanded -- a gap between the icon and a 0-width RevealLabel
          still reserves that space in a flex row, which shoves the icon left of
          the button/rail's true center and throws off the active-state highlight
          (an `inset-0` square) that's centered on the button, not the icon. */}
      <div className={cn('mb-6 flex items-center', !collapsed && 'gap-2.5')}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Droplets className="h-5 w-5" />
        </div>
        <RevealLabel collapsed={collapsed} className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold text-foreground">{t('app.title')}</p>
          <p className="truncate text-xs text-muted-foreground">{t('app.siteNameShort')}</p>
        </RevealLabel>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const active = view === item.id
          const label = t(item.labelKey)
          return (
            <button
              key={item.id}
              type="button"
              title={label}
              aria-current={active ? 'page' : undefined}
              data-tour={`nav-${item.id}`}
              onClick={() => onChange(item.id)}
              className={cn(
                'relative flex items-center rounded-lg px-3 py-2.5 text-sm font-medium transition-all motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                collapsed ? 'w-11 justify-center px-0' : 'gap-3',
                active
                  ? 'text-primary'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground hover:translate-x-0.5',
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active-indicator"
                  className="absolute inset-0 rounded-lg bg-primary/10"
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                />
              )}
              <Icon className="relative h-5 w-5 shrink-0" />
              <RevealLabel collapsed={collapsed} className="relative min-w-0">
                {label}
              </RevealLabel>
            </button>
          )
        })}
      </nav>

      <div className={cn('flex flex-col gap-1.5', collapsed && 'items-center')}>
        <div data-tour="theme-toggle">
          <ThemeToggle
            showLabel={!collapsed}
            className={collapsed ? undefined : 'w-full justify-start px-3'}
          />
        </div>
        <div data-tour="lang-toggle">
          <LanguageSwitcher collapsed={collapsed} className={collapsed ? undefined : 'w-full'} />
        </div>
        <TourHelpButton
          showLabel={!collapsed}
          className={collapsed ? undefined : 'w-full justify-start px-3'}
        />
        <UserBadge collapsed={collapsed} />
      </div>
    </aside>
  )
}
