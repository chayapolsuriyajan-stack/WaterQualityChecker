import { useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { CalibrationView } from '@/components/calibration/CalibrationView'
import { DashboardView } from '@/components/dashboard/DashboardView'
import { HistoryView } from '@/components/history/HistoryView'
import { MobileBottomNav, MobileTopBar } from '@/components/shell/MobileNav'
import { RightContextColumn } from '@/components/shell/RightContextColumn'
import { Sidebar, type ViewId } from '@/components/shell/Sidebar'
import { SensorProvider } from '@/lib/SensorProvider'

/** Aqua Monitor app shell: left sidebar / mobile nav, active view, and (dashboard-only) right context column. */
export default function App() {
  const [view, setView] = useState<ViewId>('dashboard')
  const reducedMotion = useReducedMotion()

  return (
    // SensorProvider wraps the whole shell (above the keyed motion.div below) so the single
    // shared /ws/app socket and its 30s rolling series survive `view` changes instead of being
    // torn down and reconnected/reset on every tab switch.
    <SensorProvider>
      <div className="flex h-full w-full overflow-hidden bg-background">
        {/* Desktop (lg+): full sidebar. Tablet (md): collapsed icon rail. Phone (<md): hidden. */}
        <Sidebar view={view} onChange={setView} className="hidden md:flex lg:hidden" collapsed />
        <Sidebar view={view} onChange={setView} className="hidden lg:flex" />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MobileTopBar view={view} onChange={setView} />

          <main className="flex-1 overflow-y-auto overflow-x-hidden pb-20 md:pb-0">
            <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-4 lg:flex-row md:p-6">
              <div className="min-w-0 flex-1">
                {/* Keyed motion.div (no AnimatePresence): remounting on `view` change replays the
                    entrance animation. AnimatePresence mode="wait" deadlocked here on React 19 +
                    motion 12 -- the exiting child never resolved, so the new view never mounted. */}
                <motion.div
                  key={view}
                  initial={reducedMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                >
                  {view === 'dashboard' && <DashboardView />}
                  {view === 'calibration' && <CalibrationView />}
                  {view === 'history' && <HistoryView />}
                </motion.div>
              </div>

              {view === 'dashboard' && (
                <RightContextColumn className="w-full shrink-0 lg:w-72" />
              )}
            </div>
          </main>

          <MobileBottomNav view={view} onChange={setView} />
        </div>
      </div>
    </SensorProvider>
  )
}
