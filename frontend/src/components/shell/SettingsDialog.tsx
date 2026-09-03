/**
 * Gear-icon trigger (sized like ThemeToggle) opening a Dialog with two sections:
 * "Notifications" (subscribe/unsubscribe, per-parameter warn/danger push preferences --
 * previously its own standalone NotificationSettings component, folded in here per the
 * "main setting that lists notifications" request) and "Dashboard display" (show/hide
 * toggles for each ParamGrid card + the water usage chart, backed by DashboardPrefsProvider).
 */
import { useEffect, useState, type JSX } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/cn'
import { useDashboardPrefs, type DashboardSeriesKey } from '@/lib/DashboardPrefsProvider'
import { useT } from '@/lib/i18n'
import { PARAM_META, PARAM_ORDER } from '@/lib/paramMeta'
import {
  getCurrentSubscriptionEndpoint,
  getPushPreferences,
  isPushSupported,
  registerServiceWorker,
  savePushPreferences,
  sendTestPush,
  subscribeToPush,
  unsubscribeFromPush,
  type PushParam,
  type PushPrefs,
} from '@/lib/push'

const DEFAULT_PREFS: PushPrefs = {
  temperature: { warn: false, danger: true },
  turbidity: { warn: false, danger: true },
  tds: { warn: false, danger: true },
  ec: { warn: false, danger: true },
}

// flow has no thresholds/push alerts (see thresholds.ts's decoupled RangeParam union), so
// the notification section iterates this fixed list rather than PARAM_ORDER (which includes
// flow for the display-toggle section below).
const PUSH_PARAM_ORDER: PushParam[] = ['temperature', 'turbidity', 'tds', 'ec']

interface SettingsDialogProps {
  className?: string
  showLabel?: boolean
}

export function SettingsDialog({ className, showLabel = false }: SettingsDialogProps): JSX.Element {
  const { t } = useT()
  const { visible, setVisible } = useDashboardPrefs()
  const supported = isPushSupported()

  const [open, setOpen] = useState(false)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<PushPrefs>(DEFAULT_PREFS)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [testing, setTesting] = useState(false)

  const refreshSubscriptionState = async () => {
    if (!supported) return
    setChecking(true)
    try {
      await registerServiceWorker()
      const currentEndpoint = await getCurrentSubscriptionEndpoint()
      setEndpoint(currentEndpoint)
      if (currentEndpoint) {
        const savedPrefs = await getPushPreferences(currentEndpoint)
        setPrefs(savedPrefs ?? DEFAULT_PREFS)
      }
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    if (open) {
      void refreshSubscriptionState()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleEnable = async () => {
    setBusy(true)
    try {
      const result = await subscribeToPush()
      if (result.ok) {
        toast.success(t('notif.subscribeSuccess'))
        await refreshSubscriptionState()
      } else {
        const message =
          result.error === 'permission-denied'
            ? t('notif.subscribeFailedPermission')
            : result.error === 'vapid-unavailable'
              ? t('notif.subscribeFailedUnavailable')
              : t('notif.subscribeFailed')
        // For the generic/unrecognized-error case, show the raw reason (e.g. a DOMException
        // name, or an HTTP status suffix like "subscribe-failed-503") as the toast description
        // so the cause is visible without opening devtools -- console.error in push.ts still
        // has the full detail for anything this doesn't fit on one line.
        const isKnownReason = result.error === 'permission-denied' || result.error === 'vapid-unavailable'
        toast.error(message, isKnownReason ? undefined : { description: result.error })
      }
    } finally {
      setBusy(false)
    }
  }

  const handleUnsubscribe = async () => {
    setBusy(true)
    try {
      const res = await unsubscribeFromPush()
      if (!res.ok) {
        toast.error(t('notif.unsubscribeFailed'))
        return
      }
      toast.success(t('notif.unsubscribeSuccess'))
      setEndpoint(null)
      setPrefs(DEFAULT_PREFS)
    } finally {
      setBusy(false)
    }
  }

  const handleSendTest = async () => {
    if (!endpoint) return
    setTesting(true)
    try {
      const res = await sendTestPush(endpoint)
      toast[res.ok ? 'success' : 'error'](res.ok ? t('notif.testSuccess') : t('notif.testFailed'))
    } finally {
      setTesting(false)
    }
  }

  const handleTogglePref = async (param: PushParam, severity: 'warn' | 'danger', checked: boolean) => {
    if (!endpoint) return
    const next: PushPrefs = { ...prefs, [param]: { ...prefs[param], [severity]: checked } }
    setPrefs(next)
    const ok = await savePushPreferences(endpoint, next)
    if (!ok) {
      toast.error(t('notif.prefsSaveFailed'))
      setPrefs(prefs)
    }
  }

  const handleToggleDisplay = (key: DashboardSeriesKey, checked: boolean) => {
    setVisible(key, checked)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size={showLabel ? 'default' : 'icon'}
        className={cn(
          'h-11 min-h-11 min-w-11 gap-2 focus-visible:ring-2 focus-visible:ring-offset-2',
          !showLabel && 'w-11',
          className,
        )}
        aria-label={t('settings.bellAria')}
        title={t('settings.title')}
        onClick={() => setOpen(true)}
      >
        <SettingsIcon aria-hidden="true" />
        {showLabel && <span>{t('settings.title')}</span>}
      </Button>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* --- Dashboard display -------------------------------------------------- */}
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('settings.displaySection')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.displayDescription')}</p>
            </div>
            <div className="space-y-2">
              {PARAM_ORDER.map((param) => (
                <div key={param} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-foreground">{t(PARAM_META[param].labelKey)}</span>
                  <Switch
                    checked={visible[param]}
                    onCheckedChange={(checked) => handleToggleDisplay(param, checked)}
                    aria-label={t(PARAM_META[param].labelKey)}
                  />
                </div>
              ))}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-foreground">{t('settings.showWaterUsage')}</span>
                <Switch
                  checked={visible.waterUsage}
                  onCheckedChange={(checked) => handleToggleDisplay('waterUsage', checked)}
                  aria-label={t('settings.showWaterUsage')}
                />
              </div>
            </div>
          </div>

          {/* --- Notifications -------------------------------------------------- */}
          <div className="space-y-3 border-t border-border pt-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t('settings.notificationsSection')}</p>
              <DialogDescription>{t('notif.description')}</DialogDescription>
            </div>

            {!supported && (
              <p className="text-sm text-muted-foreground">
                {window.isSecureContext ? t('notif.unsupported') : t('notif.insecureContext')}
              </p>
            )}

            {supported && !endpoint && (
              <Button type="button" disabled={busy || checking} onClick={() => void handleEnable()}>
                {busy ? t('notif.enabling') : t('notif.enable')}
              </Button>
            )}

            {supported && endpoint && (
              <div className="space-y-4">
                <div className="space-y-3">
                  <p className="text-sm font-medium text-foreground">{t('notif.prefsTitle')}</p>
                  <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 gap-y-3">
                    <span className="text-xs font-medium text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">{t('status.caution')}</span>
                    <span className="text-xs font-medium text-muted-foreground">{t('status.danger')}</span>
                    {PUSH_PARAM_ORDER.map((param) => (
                      <div key={param} className="contents">
                        <span className="text-sm text-foreground">{t(PARAM_META[param].labelKey)}</span>
                        <Switch
                          checked={prefs[param].warn}
                          onCheckedChange={(checked) => void handleTogglePref(param, 'warn', checked)}
                          aria-label={`${t(PARAM_META[param].labelKey)} ${t('status.caution')}`}
                        />
                        <Switch
                          checked={prefs[param].danger}
                          onCheckedChange={(checked) => void handleTogglePref(param, 'danger', checked)}
                          aria-label={`${t(PARAM_META[param].labelKey)} ${t('status.danger')}`}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={testing}
                    onClick={() => void handleSendTest()}
                  >
                    {testing ? t('notif.sendingTest') : t('notif.sendTest')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void handleUnsubscribe()}
                  >
                    {busy ? t('notif.unsubscribing') : t('notif.unsubscribe')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
