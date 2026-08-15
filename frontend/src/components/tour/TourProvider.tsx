/**
 * Context/state for the guided onboarding tour. Auto-starts once per browser
 * (versioned localStorage flag, mirroring `lib/i18n.tsx`'s persistence
 * style) and is otherwise replayable on demand via `start()` (see
 * `TourHelpButton`). Needs `view`/`setView` from `App.tsx` as props so a
 * step that targets non-dashboard UI can switch tabs as the tour advances
 * onto it (see `TourStep.view` in `tourSteps.ts`).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { ViewId } from '@/components/shell/Sidebar'
import { TOUR_STEPS, type TourStep } from './tourSteps'

const STORAGE_KEY = 'hydro-tour-v1-seen'

function readSeen(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // localStorage can throw in restrictive environments (private browsing, etc).
    return true
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // Ignore write failures.
  }
}

interface TourContextValue {
  isActive: boolean
  currentStep: TourStep | null
  currentIndex: number
  steps: TourStep[]
  /** Current `view`, exposed so `TourOverlay` can re-resolve a step's target after a tab switch commits. */
  view: ViewId
  start: () => void
  next: () => void
  prev: () => void
  skip: () => void
}

const TourContext = createContext<TourContextValue | null>(null)

interface TourProviderProps {
  view: ViewId
  setView: (view: ViewId) => void
  children: ReactNode
}

export function TourProvider({ view, setView, children }: TourProviderProps) {
  const [isActive, setIsActive] = useState(false)
  const [index, setIndex] = useState(0)

  // Auto-start once per browser, after first mount (not during render, so it
  // never fires twice from StrictMode's render-phase double-invoke).
  useEffect(() => {
    if (!readSeen()) setIsActive(true)
  }, [])

  const currentStep = isActive ? (TOUR_STEPS[index] ?? null) : null

  // Drive `view` to match the active step's requirement, if any.
  useEffect(() => {
    if (currentStep?.view && currentStep.view !== view) {
      setView(currentStep.view)
    }
    // Only re-run when the step itself changes -- `view`/`setView` changing
    // (e.g. the user manually switches tabs mid-tour) shouldn't re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep])

  const finish = useCallback(() => {
    setIsActive(false)
    setIndex(0)
    markSeen()
  }, [])

  const start = useCallback(() => {
    setIndex(0)
    setIsActive(true)
  }, [])

  const next = useCallback(() => {
    setIndex((i) => {
      if (i + 1 >= TOUR_STEPS.length) {
        finish()
        return i
      }
      return i + 1
    })
  }, [finish])

  const prev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1))
  }, [])

  const skip = useCallback(() => {
    finish()
  }, [finish])

  const value = useMemo<TourContextValue>(
    () => ({ isActive, currentStep, currentIndex: index, steps: TOUR_STEPS, view, start, next, prev, skip }),
    [isActive, currentStep, index, view, start, next, prev, skip],
  )

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext)
  if (!ctx) {
    throw new Error('useTour() must be used within a <TourProvider>')
  }
  return ctx
}
