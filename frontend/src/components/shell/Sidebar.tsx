import type { LucideIcon } from 'lucide-react'
import { Droplets, Gauge, History, SlidersHorizontal } from 'lucide-react'
import { motion } from 'motion/react'
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
  /** Icon-only collapsed rail for md (tablet) breakpoints. */
  collapsed?: boolean
  className?: string
}

/** Fixed left navigation rail — full-width on desktop (lg+), icon-only rail on tablet (md) when collapsed. */
export function Sidebar({ view, onChange, collapsed = false, className }: SidebarProps) {
  const { t } = useT()

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-border bg-card/60 backdrop-blur-sm',
        collapsed ? 'w-[72px] items-center px-2 py-4' : 'w-64 px-4 py-5',
        className,
      )}
    >
      <div
        className={cn(
          'mb-6 flex items-center gap-2.5',
          collapsed && 'justify-center',
        )}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Droplets className="h-5 w-5" />
        </div>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold text-foreground">{t('app.title')}</p>
            <p className="truncate text-xs text-muted-foreground">{t('app.siteNameShort')}</p>
          </div>
        )}
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
              onClick={() => onChange(item.id)}
              className={cn(
                'relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                collapsed && 'w-11 justify-center px-0',
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
              <Icon className="relative h-[18px] w-[18px] shrink-0" />
              {!collapsed && <span className="relative min-w-0 truncate">{label}</span>}
            </button>
          )
        })}
      </nav>

      <div className={cn('flex flex-col gap-1.5', collapsed && 'items-center')}>
        <ThemeToggle className={collapsed ? undefined : 'w-full justify-start px-3'} />
        <LanguageSwitcher collapsed={collapsed} className={collapsed ? undefined : 'w-full'} />
        <UserBadge collapsed={collapsed} />
      </div>
    </aside>
  )
}
