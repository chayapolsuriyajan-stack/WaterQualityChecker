import { Droplets, Menu } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { NAV_ITEMS, type ViewId } from './Sidebar'
import { UserBadge } from './UserBadge'

interface MobileNavProps {
  view: ViewId
  onChange: (view: ViewId) => void
}

/** Phone (<768px) top bar: hamburger opening a Sheet drawer with the full nav. */
export function MobileTopBar({ view, onChange }: MobileNavProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card/80 px-3 backdrop-blur-sm md:hidden">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Droplets className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold text-foreground">Aqua Monitor</span>
      </div>

      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="Open menu"
            className="flex h-11 w-11 items-center justify-center rounded-md text-foreground transition-colors hover:bg-secondary"
          >
            <Menu className="h-5 w-5" />
          </button>
        </SheetTrigger>
        <SheetContent side="left" className="flex w-72 flex-col p-4">
          <SheetHeader className="mb-4 text-left">
            <SheetTitle>Aqua Monitor</SheetTitle>
          </SheetHeader>
          <nav className="flex flex-1 flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const active = view === item.id
              return (
                <SheetClose key={item.id} asChild>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onChange(item.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors',
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                    )}
                  >
                    <Icon className="h-[18px] w-[18px] shrink-0" />
                    <span>
                      {item.labelTh} <span className="text-muted-foreground/70">/ {item.labelEn}</span>
                    </span>
                  </button>
                </SheetClose>
              )
            })}
          </nav>
          <UserBadge />
        </SheetContent>
      </Sheet>
    </header>
  )
}

/** Phone (<768px) fixed bottom tab bar — the 3 primary views, ≥44px touch targets. */
export function MobileBottomNav({ view, onChange }: MobileNavProps) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-stretch border-t border-border bg-card/95 backdrop-blur-sm md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon
        const active = view === item.id
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onChange(item.id)}
            className={cn(
              'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
              active ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <Icon className="h-5 w-5" />
            <span className="truncate px-1">{item.labelEn}</span>
          </button>
        )
      })}
    </nav>
  )
}
