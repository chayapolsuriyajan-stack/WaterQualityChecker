/**
 * Dashboard display preferences: which series show on the main Dashboard's ParamGrid cards
 * and the two flow charts. Persisted to localStorage, modeled directly on lib/i18n.tsx's
 * LanguageProvider (same read-with-fallback + try/catch pattern for private-browsing safety).
 * Set from the Settings dialog's "Dashboard display" section.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { PARAM_ORDER, type ParamKey } from './paramMeta'

const STORAGE_KEY = 'aqua-dashboard-series'

/** `waterUsage` isn't a ParamKey/grid card (it's the daily-usage chart specifically), so it
 * gets its own toggle entry alongside the per-param ones. */
export type DashboardSeriesKey = ParamKey | 'waterUsage'

export type DashboardVisibility = Record<DashboardSeriesKey, boolean>

function defaultVisibility(): DashboardVisibility {
  const visible = { waterUsage: true } as DashboardVisibility
  for (const param of PARAM_ORDER) visible[param] = true
  return visible
}

function readStoredVisibility(): DashboardVisibility {
  const defaults = defaultVisibility()
  if (typeof window === 'undefined') return defaults
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) return defaults
    const parsed = JSON.parse(stored) as Partial<Record<string, unknown>>
    const merged = { ...defaults }
    for (const key of Object.keys(defaults) as DashboardSeriesKey[]) {
      if (typeof parsed[key] === 'boolean') merged[key] = parsed[key]
    }
    return merged
  } catch {
    // localStorage/JSON can throw in restrictive environments (private browsing, etc).
    return defaults
  }
}

interface DashboardPrefsContextValue {
  visible: DashboardVisibility
  setVisible: (key: DashboardSeriesKey, value: boolean) => void
}

const DashboardPrefsContext = createContext<DashboardPrefsContextValue | null>(null)

export function DashboardPrefsProvider({ children }: { children: ReactNode }) {
  const [visible, setVisibleState] = useState<DashboardVisibility>(() => readStoredVisibility())

  const setVisible = useCallback((key: DashboardSeriesKey, value: boolean) => {
    setVisibleState((prev) => {
      const next = { ...prev, [key]: value }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Ignore write failures (private browsing, storage disabled, etc).
      }
      return next
    })
  }, [])

  const value = useMemo<DashboardPrefsContextValue>(
    () => ({ visible, setVisible }),
    [visible, setVisible],
  )

  return <DashboardPrefsContext.Provider value={value}>{children}</DashboardPrefsContext.Provider>
}

export function useDashboardPrefs(): DashboardPrefsContextValue {
  const ctx = useContext(DashboardPrefsContext)
  if (!ctx) {
    throw new Error('useDashboardPrefs() must be used within a <DashboardPrefsProvider>')
  }
  return ctx
}
