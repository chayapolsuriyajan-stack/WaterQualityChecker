/**
 * Guest/Admin UI role. NOT authentication -- there is no password and the backend does
 * not enforce this; it only drives which controls the frontend shows (Calibration tab,
 * station rename). See docs/superpowers/specs/2026-09-04-guest-admin-roles-design.md.
 * Modeled on DashboardPrefsProvider.tsx's localStorage read/write pattern.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type Role = 'guest' | 'admin'

const STORAGE_KEY = 'aqua-role'

function readStoredRole(): Role {
  if (typeof window === 'undefined') return 'guest'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === 'admin' ? 'admin' : 'guest'
  } catch {
    // localStorage can throw in restrictive environments (private browsing, etc).
    return 'guest'
  }
}

interface RoleContextValue {
  role: Role
  toggleRole: () => void
}

const RoleContext = createContext<RoleContextValue | null>(null)

export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<Role>(() => readStoredRole())

  const toggleRole = useCallback(() => {
    setRoleState((prev) => {
      const next: Role = prev === 'admin' ? 'guest' : 'admin'
      try {
        window.localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // Ignore write failures (private browsing, storage disabled, etc).
      }
      return next
    })
  }, [])

  const value = useMemo<RoleContextValue>(() => ({ role, toggleRole }), [role, toggleRole])

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>
}

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext)
  if (!ctx) {
    throw new Error('useRole() must be used within a <RoleProvider>')
  }
  return ctx
}
