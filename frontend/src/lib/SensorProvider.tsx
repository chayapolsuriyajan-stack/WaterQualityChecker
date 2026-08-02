import { createContext, useContext } from 'react'
import { useSensorSocket, type UseSensorSocketResult } from './useSensorSocket'

/**
 * Shares a single `/ws/app` socket (and its simulation fallback timer) across
 * the whole app, instead of each consumer (DashboardView, RightContextColumn, ...)
 * opening its own connection. Must be mounted above any view that gets remounted
 * on tab switch so the rolling sparkline series survives navigation.
 */
const SensorContext = createContext<UseSensorSocketResult | null>(null)

export function SensorProvider({ children }: { children: React.ReactNode }) {
  const sensor = useSensorSocket()
  return <SensorContext.Provider value={sensor}>{children}</SensorContext.Provider>
}

export function useSensorData(): UseSensorSocketResult {
  const ctx = useContext(SensorContext)
  if (!ctx) {
    throw new Error('useSensorData must be used within a SensorProvider')
  }
  return ctx
}
