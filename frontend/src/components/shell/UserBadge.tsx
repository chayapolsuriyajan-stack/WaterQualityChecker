import { LogOut, User } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

interface UserBadgeProps {
  /** Icon-only compact form, for the collapsed tablet rail. */
  collapsed?: boolean
  className?: string
}

/** Static "Guest" identity pinned to the bottom of the sidebar (no auth). */
export function UserBadge({ collapsed = false, className }: UserBadgeProps) {
  const { t } = useT()

  if (collapsed) {
    return (
      <div
        title={t('user.guest')}
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
        <p className="truncate text-sm font-medium leading-tight text-foreground">{t('user.guest')}</p>
        <p className="truncate text-xs leading-tight text-muted-foreground">{t('user.role')}</p>
      </div>
      <button
        type="button"
        aria-label={t('user.signOut')}
        title={t('user.signOut')}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  )
}
