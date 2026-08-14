import { useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { AnimatedBackground } from '@/components/shell/AnimatedBackground'
import { CalibrationView } from '@/components/calibration/CalibrationView'
import { DashboardView } from '@/components/dashboard/DashboardView'
import { HistoryView } from '@/components/history/HistoryView'
import { MobileBottomNav, MobileTopBar } from '@/components/shell/MobileNav'
import { RailHoverPanel } from '@/components/shell/RailHoverPanel'
import { RightContextColumn } from '@/components/shell/RightContextColumn'
import type { ViewId } from '@/components/shell/Sidebar'
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
      <div className="relative flex h-full w-full overflow-hidden bg-background">
        <AnimatedBackground reducedMotion={!!reducedMotion} />

        {/* Tablet and desktop (md+): collapsed icon-only rail by default, expanding
            to the full labeled sidebar on hover or via the trigger button. Phone
            (<md): hidden (MobileTopBar/Sheet instead). */}
        <RailHoverPanel view={view} onChange={setView} className="relative z-20 hidden md:flex" />

        <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
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
