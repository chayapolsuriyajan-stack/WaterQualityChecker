/**
 * Bell-icon trigger (sized like ThemeToggle) opening a Dialog to manage web
 * push notifications: subscribe/unsubscribe and per-parameter warn/danger
 * preferences. Breach detection happens server-side (main.py); this is
 * purely the browser-side opt-in + preferences UI.
 */
import { useEffect, useState, type JSX } from 'react'
import { Bell, BellOff } from 'lucide-react'
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
import { useT } from '@/lib/i18n'
import { PARAM_META, PARAM_ORDER } from '@/lib/paramMeta'
import {
  getCurrentSubscriptionEndpoint,
  getPushPreferences,
  isPushSupported,
  registerServiceWorker,
  savePushPreferences,
  subscribeToPush,
  unsubscribeFromPush,
  type PushPrefs,
} from '@/lib/push'

const DEFAULT_PREFS: PushPrefs = {
  temperature: { warn: false, danger: true },
  turbidity: { warn: false, danger: true },
  tds: { warn: false, danger: true },
  ec: { warn: false, danger: true },
}

interface NotificationSettingsProps {
  className?: string
  showLabel?: boolean
}

export function NotificationSettings({ className, showLabel = false }: NotificationSettingsProps): JSX.Element {
  const { t } = useT()
  const supported = isPushSupported()

  const [open, setOpen] = useState(false)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<PushPrefs>(DEFAULT_PREFS)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)

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
        toast.error(message)
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

  const handleTogglePref = async (param: keyof PushPrefs, severity: 'warn' | 'danger', checked: boolean) => {
    if (!endpoint) return
    const next: PushPrefs = { ...prefs, [param]: { ...prefs[param], [severity]: checked } }
    setPrefs(next)
    const ok = await savePushPreferences(endpoint, next)
    if (!ok) {
      toast.error(t('notif.prefsSaveFailed'))
      setPrefs(prefs)
    }
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
        aria-label={t('notif.bellAria')}
        title={t('notif.title')}
        onClick={() => setOpen(true)}
      >
        {endpoint ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />}
        {showLabel && <span>{t('notif.title')}</span>}
      </Button>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('notif.title')}</DialogTitle>
          <DialogDescription>{t('notif.description')}</DialogDescription>
        </DialogHeader>

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
                {PARAM_ORDER.map((param) => (
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
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void handleUnsubscribe()}
            >
              {busy ? t('notif.unsubscribing') : t('notif.unsubscribe')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
