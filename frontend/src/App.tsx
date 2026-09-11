import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { AnimatedBackground } from '@/components/shell/AnimatedBackground'
import { CalibrationView } from '@/components/calibration/CalibrationView'
import { DashboardView } from '@/components/dashboard/DashboardView'
import { HistoryView } from '@/components/history/HistoryView'
import { MobileBottomNav, MobileTopBar } from '@/components/shell/MobileNav'
import { RailHoverPanel } from '@/components/shell/RailHoverPanel'
import { RightContextColumn } from '@/components/shell/RightContextColumn'
import type { ViewId } from '@/components/shell/Sidebar'
import { TourOverlay } from '@/components/tour/TourOverlay'
import { TourProvider } from '@/components/tour/TourProvider'
import { useT } from '@/lib/i18n'
import { getCurrentSubscriptionEndpoint, isPushSupported, syncPushLang } from '@/lib/push'
import { useRole } from '@/lib/RoleProvider'
import { SensorProvider, useSensorData } from '@/lib/SensorProvider'

/**
 * Syncs the browser tab title to the `/live` polling connection state. Runs
 * regardless of which `view` tab is active (connection state is global, not
 * per-view) and always in English -- an explicit decision to not follow the
 * EN/ไทย toggle, since a tab title is glanced at, not read.
 */
function TabTitleSync() {
  const { connected } = useSensorData()
  useEffect(() => {
    document.title = connected ? 'AquaMonitor — Connected' : 'AquaMonitor — Offline'
  }, [connected])
  return null
}

/**
 * Keeps an already-subscribed device's push-notification language in sync with the
 * dashboard's language toggle. `subscribeToPush` (SettingsDialog.tsx) only sets `lang` at
 * the moment a device first subscribes; without this, a subscriber who later switches
 * languages would keep getting breach alerts in whatever language they subscribed under
 * until they happened to reopen Settings (which resyncs nothing on its own either -- it
 * only reads state). Runs app-wide, not just while Settings is open, and skips entirely on
 * the very first mount (the ref) so a fresh page load doesn't fire a redundant sync for a
 * lang that was just sent at subscribe time.
 */
function PushLangSync() {
  const { lang } = useT()
  const isFirstRun = useRef(true)

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      return
    }
    if (!isPushSupported()) return
    void (async () => {
      const endpoint = await getCurrentSubscriptionEndpoint()
      if (endpoint) await syncPushLang(endpoint, lang)
    })()
  }, [lang])

  return null
}

/** AquaMonitor app shell: left sidebar / mobile nav, active view, and (dashboard-only) right context column. */
export default function App() {
  const [view, setView] = useState<ViewId>('dashboard')
  const { role } = useRole()

  // A guest session must never land on (or stay on) the Calibration view -- covers both
  // an admin mid-session switching to guest, and (if view state is ever persisted in the
  // future) a guest reload landing on a stale 'calibration' value.
  useEffect(() => {
    if (role === 'guest' && view === 'calibration') {
      setView('dashboard')
    }
  }, [role, view])
  const reducedMotion = useReducedMotion()

  return (
    // SensorProvider wraps the whole shell (above the keyed motion.div below) so the single
    // shared /live polling loop and its 30s rolling series survive `view` changes instead of
    // being torn down and reconnected/reset on every tab switch.
    <SensorProvider>
      <TabTitleSync />
      <PushLangSync />
      <TourProvider view={view} setView={setView}>
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
        <TourOverlay />
      </TourProvider>
    </SensorProvider>
  )
}
