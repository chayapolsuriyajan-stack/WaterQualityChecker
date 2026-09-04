import { LogOut, ShieldCheck, User } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useRole } from '@/lib/RoleProvider'

interface UserBadgeProps {
  /** Icon-only compact form, for the collapsed tablet rail. */
  collapsed?: boolean
  className?: string
}

/**
 * Bottom-of-sidebar role badge. Shows the current Guest/Admin role and a button that
 * switches between them -- NOT a real sign-in/sign-out (see RoleProvider.tsx: no
 * password, no backend enforcement).
 */
export function UserBadge({ collapsed = false, className }: UserBadgeProps) {
  const { t } = useT()
  const { role, toggleRole } = useRole()
  const isAdmin = role === 'admin'
  const roleLabel = isAdmin ? t('user.admin') : t('user.guest')
  const roleSubLabel = isAdmin ? t('user.roleAdmin') : t('user.role')
  const switchLabel = isAdmin ? t('user.switchToGuest') : t('user.switchToAdmin')
  const RoleIcon = isAdmin ? ShieldCheck : User

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggleRole}
        title={`${roleLabel} — ${switchLabel}`}
        aria-label={switchLabel}
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 text-primary transition-colors hover:bg-primary/25',
          className,
        )}
      >
        <RoleIcon className="h-4 w-4" />
      </button>
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
        <RoleIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight text-foreground">{roleLabel}</p>
        <p className="truncate text-xs leading-tight text-muted-foreground">{roleSubLabel}</p>
      </div>
      <button
        type="button"
        onClick={toggleRole}
        aria-label={switchLabel}
        title={switchLabel}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  )
}
