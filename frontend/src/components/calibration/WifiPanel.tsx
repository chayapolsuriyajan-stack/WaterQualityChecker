/**
 * USB WiFi provisioning panel (Calibration > WiFi). Talks to main.py's /wifi/* routes, which
 * themselves bridge to the ESP32 over its USB-serial port -- a separate channel from every
 * other endpoint in this app, since the whole point is reconfiguring WiFi at a moment the
 * board may have no working WiFi yet (see wifi_serial.py's header comment). An OS-style
 * network picker: scan, pick a network, type a password if it's secured, connect.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, RefreshCw, SignalHigh, SignalLow, SignalMedium, SignalZero, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { connectWifi, getWifiBackend, getWifiStatus, scanWifiNetworks, setWifiBackend } from '@/lib/api'
import { useT } from '@/lib/i18n'
import type { WifiNetwork } from '@/lib/types'

const STATUS_QUERY_KEY = ['wifi-status'] as const
const BACKEND_QUERY_KEY = ['wifi-backend'] as const

function signalIcon(rssi: number) {
  if (rssi >= -50) return SignalHigh
  if (rssi >= -70) return SignalMedium
  if (rssi >= -80) return SignalLow
  return SignalZero
}

export function WifiPanel() {
  const { t } = useT()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<WifiNetwork | null>(null)
  const [password, setPassword] = useState('')
  const [backendHost, setBackendHost] = useState('')
  const [backendApiKey, setBackendApiKey] = useState('')
  const [backendUseHttps, setBackendUseHttps] = useState(true)

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: getWifiStatus,
    refetchInterval: 10_000,
  })

  const { data: backendStatus } = useQuery({
    queryKey: BACKEND_QUERY_KEY,
    queryFn: getWifiBackend,
    refetchInterval: 10_000,
  })

  const scanMutation = useMutation({
    mutationFn: scanWifiNetworks,
    onError: () => toast.error(t('wifi.scanFailed')),
  })

  const connectMutation = useMutation({
    mutationFn: ({ ssid, password }: { ssid: string; password: string }) => connectWifi(ssid, password),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(t('wifi.connectSuccess', { ip: result.ip }))
        setSelected(null)
        setPassword('')
        void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
      } else {
        toast.error(t('wifi.connectFailed'), { description: result.error })
      }
    },
    onError: () => toast.error(t('wifi.connectFailed')),
  })

  const backendMutation = useMutation({
    mutationFn: ({ host, apiKey, useHttps }: { host: string; apiKey: string; useHttps: boolean }) =>
      setWifiBackend(host, apiKey, useHttps),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(t('wifi.backendSaveSuccess'))
        setBackendHost('')
        setBackendApiKey('')
        void queryClient.invalidateQueries({ queryKey: BACKEND_QUERY_KEY })
      } else {
        toast.error(t('wifi.backendSaveFailed'), { description: result.error })
      }
    },
    onError: () => toast.error(t('wifi.backendSaveFailed')),
  })

  const networks = scanMutation.data?.ok ? scanMutation.data.networks : []
  const espNotFound = status !== undefined && !status.ok
  const connecting = connectMutation.isPending

  const handleConnect = () => {
    if (!selected) return
    connectMutation.mutate({ ssid: selected.ssid, password: selected.secured ? password : '' })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('wifi.title')}</CardTitle>
          <CardDescription>{t('wifi.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!statusLoading && espNotFound && (
            <div className="flex items-center gap-2 rounded-md bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
              <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t('wifi.notDetected')}
            </div>
          )}
          {status?.ok && (
            <div className="rounded-md bg-secondary/40 px-3 py-2 text-sm">
              {status.connected ? (
                <span className="text-foreground">
                  {t('wifi.currentlyConnected', { ssid: status.ssid, ip: status.ip })}
                </span>
              ) : (
                <span className="text-muted-foreground">{t('wifi.notConnected')}</span>
              )}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            disabled={scanMutation.isPending}
            onClick={() => scanMutation.mutate()}
          >
            <RefreshCw className={scanMutation.isPending ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'} />
            {scanMutation.isPending ? t('wifi.scanning') : t('wifi.scan')}
          </Button>

          {networks.length > 0 && (
            <ul className="space-y-1.5">
              {networks.map((network) => {
                const SignalIcon = signalIcon(network.rssi)
                const isSelected = selected?.ssid === network.ssid
                return (
                  <li key={network.ssid}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(network)
                        setPassword('')
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                        isSelected
                          ? 'border-primary/40 bg-primary/10'
                          : 'border-border bg-card hover:bg-secondary'
                      }`}
                    >
                      <SignalIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{network.ssid}</span>
                      {network.secured && (
                        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                    </button>

                    {isSelected && (
                      <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-end">
                        {network.secured && (
                          <div className="flex-1 space-y-1.5">
                            <Label htmlFor="wifi-password">{t('wifi.passwordLabel')}</Label>
                            <Input
                              id="wifi-password"
                              type="password"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              placeholder={t('wifi.passwordPlaceholder')}
                            />
                          </div>
                        )}
                        <Button
                          type="button"
                          disabled={connecting || (network.secured && password.length === 0)}
                          onClick={handleConnect}
                        >
                          {connecting ? t('wifi.connecting') : t('wifi.connect')}
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {scanMutation.data && !scanMutation.data.ok && (
            <p className="text-sm text-destructive">{scanMutation.data.error}</p>
          )}
          {scanMutation.isSuccess && scanMutation.data.ok && networks.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('wifi.noNetworks')}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('wifi.backendTitle')}</CardTitle>
          <CardDescription>{t('wifi.backendDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {backendStatus?.ok && (
            <div className="rounded-md bg-secondary/40 px-3 py-2 text-sm">
              {backendStatus.fixed ? (
                <span className="text-foreground">
                  {t('wifi.backendCurrentFixed', { host: backendStatus.host })}
                  {backendStatus.https ? ` (${t('wifi.backendHttpsOn')})` : ''}
                  {backendStatus.hasApiKey ? ` · ${t('wifi.backendKeySet')}` : ''}
                </span>
              ) : (
                <span className="text-muted-foreground">{t('wifi.backendCurrentAuto')}</span>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="wifi-backend-host">{t('wifi.backendHostLabel')}</Label>
            <Input
              id="wifi-backend-host"
              value={backendHost}
              onChange={(e) => setBackendHost(e.target.value)}
              placeholder={t('wifi.backendHostPlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wifi-backend-key">{t('wifi.backendApiKeyLabel')}</Label>
            <Input
              id="wifi-backend-key"
              type="password"
              value={backendApiKey}
              onChange={(e) => setBackendApiKey(e.target.value)}
              placeholder={t('wifi.backendApiKeyPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">{t('wifi.backendApiKeyHint')}</p>
          </div>

          <div className="flex items-center gap-2.5">
            <Switch id="wifi-backend-https" checked={backendUseHttps} onCheckedChange={setBackendUseHttps} />
            <Label htmlFor="wifi-backend-https" className="font-normal">
              {t('wifi.backendHttpsLabel')}
            </Label>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={backendMutation.isPending || backendHost.trim().length === 0}
              onClick={() =>
                backendMutation.mutate({
                  host: backendHost.trim(),
                  apiKey: backendApiKey,
                  useHttps: backendUseHttps,
                })
              }
            >
              {backendMutation.isPending ? t('wifi.backendSaving') : t('wifi.backendSave')}
            </Button>

            {backendStatus?.ok && backendStatus.fixed && (
              <Button
                type="button"
                variant="outline"
                disabled={backendMutation.isPending}
                onClick={() => backendMutation.mutate({ host: '', apiKey: '', useHttps: false })}
              >
                {t('wifi.backendClear')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
