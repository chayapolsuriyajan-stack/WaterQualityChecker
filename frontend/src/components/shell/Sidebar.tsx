import type { LucideIcon } from 'lucide-react'
import { Droplets, Gauge, History, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/cn'
import { UserBadge } from './UserBadge'

export type ViewId = 'dashboard' | 'calibration' | 'history'

export interface NavItem {
  id: ViewId
  labelTh: string
  labelEn: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', labelTh: 'แดชบอร์ด', labelEn: 'Dashboard', icon: Gauge },
  { id: 'calibration', labelTh: 'ปรับเทียบ', labelEn: 'Calibration', icon: SlidersHorizontal },
  { id: 'history', labelTh: 'ประวัติ', labelEn: 'History', icon: History },
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
            <p className="truncate text-sm font-semibold text-foreground">Aqua Monitor</p>
            <p className="truncate text-xs text-muted-foreground">อ่างแก้ว / Ang Kaew</p>
          </div>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const active = view === item.id
          return (
            <button
              key={item.id}
              type="button"
              title={`${item.labelTh} / ${item.labelEn}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => onChange(item.id)}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                collapsed && 'w-11 justify-center px-0',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              {!collapsed && (
                <span className="min-w-0 truncate">
                  {item.labelTh} <span className="text-muted-foreground/70">/ {item.labelEn}</span>
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <UserBadge collapsed={collapsed} />
    </aside>
  )
}
