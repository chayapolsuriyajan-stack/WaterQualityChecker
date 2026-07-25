import { LogOut, User } from 'lucide-react'
import { cn } from '@/lib/cn'

interface UserBadgeProps {
  /** Icon-only compact form, for the collapsed tablet rail. */
  collapsed?: boolean
  className?: string
}

/** Static "Guest" identity pinned to the bottom of the sidebar (no auth). */
export function UserBadge({ collapsed = false, className }: UserBadgeProps) {
  if (collapsed) {
    return (
      <div
        title="Guest / ผู้เยี่ยมชม"
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 text-primary',
          className,
        )}
      >
        <User className="h-4 w-4" />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-secondary/50 px-3 py-2.5',
        className,
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <User className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight text-foreground">Guest</p>
        <p className="truncate text-xs leading-tight text-muted-foreground">ผู้เยี่ยมชม</p>
      </div>
      <button
        type="button"
        aria-label="Log out"
        title="Log out"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  )
}
