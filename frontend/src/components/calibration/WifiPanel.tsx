/**
 * USB WiFi provisioning panel (Calibration > WiFi). Talks DIRECTLY to the ESP32 over the
 * browser's Web Serial API (see lib/webSerial.ts) -- no backend involved. Clicking "Connect to
 * board" opens the browser's own native device picker (same UX as python.microbit.org's
 * Connect button), the user selects the board's USB-serial port, and every command after that
 * goes straight from this tab to the board. This replaced an earlier version that bridged
 * through main.py's /wifi/* routes (wifi_serial.py + pyserial on the machine running the
 * backend) -- that only worked from the browser on the SAME machine as a running backend, and
 * depended on server-side USB auto-detect ever finding the right port. Web Serial needs no
 * backend at all and lets the user pick the exact device themselves.
 *
 * Chromium-only (Chrome/Edge/Opera -- not Firefox/Safari) and needs a secure context
 * (https:// or http://localhost); unsupported browsers get a clear message instead of a
 * silently broken panel.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, RefreshCw, SignalHigh, SignalLow, SignalMedium, SignalZero, Usb, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useT } from '@/lib/i18n'
import type { WifiNetwork } from '@/lib/types'
import * as webSerial from '@/lib/webSerial'

const STATUS_QUERY_KEY = ['wifi-status'] as const
const BACKEND_QUERY_KEY = ['wifi-backend'] as const
const STATION_QUERY_KEY = ['wifi-station'] as const

function signalIcon(rssi: number) {
  if (rssi >= -50) return SignalHigh
  if (rssi >= -70) return SignalMedium
  if (rssi >= -80) return SignalLow
  return SignalZero
}

export function WifiPanel() {
  const { t } = useT()
  const queryClient = useQueryClient()
  const [connected, setConnected] = useState(webSerial.isConnected())
  const [connecting, setConnecting] = useState(false)
  const [selected, setSelected] = useState<WifiNetwork | null>(null)
  const [password, setPassword] = useState('')
  const [backendHost, setBackendHost] = useState('')
  const [backendApiKey, setBackendApiKey] = useState('')
  const [backendUseHttps, setBackendUseHttps] = useState(true)
  const [stationName, setStationName] = useState('')

  const supported = webSerial.isSupported()

  useEffect(() => {
    return webSerial.onDisconnect(() => {
      setConnected(false)
      toast.error(t('wifi.deviceDisconnected'))
      void queryClient.resetQueries({ queryKey: STATUS_QUERY_KEY })
      void queryClient.resetQueries({ queryKey: BACKEND_QUERY_KEY })
      void queryClient.resetQueries({ queryKey: STATION_QUERY_KEY })
    })
  }, [queryClient, t])

  const handleConnectDevice = async () => {
    setConnecting(true)
    const result = await webSerial.connect()
    setConnecting(false)
    if (result.ok) {
      setConnected(true)
      void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: BACKEND_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: STATION_QUERY_KEY })
    } else {
      toast.error(t('wifi.deviceConnectFailed'), { description: result.error })
    }
  }

  const handleDisconnectDevice = async () => {
    await webSerial.disconnect()
    setConnected(false)
  }

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => webSerial.getStatus(),
    enabled: connected,
    refetchInterval: connected ? 10_000 : false,
  })

  const { data: backendStatus } = useQuery({
    queryKey: BACKEND_QUERY_KEY,
    queryFn: () => webSerial.getBackendStatus(),
    enabled: connected,
    refetchInterval: connected ? 10_000 : false,
  })

  const { data: stationStatus } = useQuery({
    queryKey: STATION_QUERY_KEY,
    queryFn: () => webSerial.getStationStatus(),
    enabled: connected,
    refetchInterval: connected ? 10_000 : false,
  })

  const scanMutation = useMutation({
    mutationFn: () => webSerial.scanNetworks(),
    onError: () => toast.error(t('wifi.scanFailed')),
  })

  const connectMutation = useMutation({
    mutationFn: ({ ssid, password }: { ssid: string; password: string }) => webSerial.setWifi(ssid, password),
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
      webSerial.setBackendHost(host, apiKey, useHttps),
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

  const stationMutation = useMutation({
    mutationFn: (name: string) => (name.trim().length === 0 ? webSerial.clearStationName() : webSerial.setStationName(name.trim())),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(t('wifi.stationSaveSuccess'))
        setStationName('')
        void queryClient.invalidateQueries({ queryKey: STATION_QUERY_KEY })
      } else {
        toast.error(t('wifi.stationSaveFailed'), { description: result.error })
      }
    },
    onError: () => toast.error(t('wifi.stationSaveFailed')),
  })

  const testMutation = useMutation({
    mutationFn: () => webSerial.testBackendConnection(),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(t('wifi.backendTestFailed'), { description: result.error })
        return
      }
      if (result.reachable) {
        toast.success(t('wifi.backendTestSuccess', { detail: result.detail }))
      } else {
        toast.error(t('wifi.backendTestUnreachable'), { description: result.detail })
      }
    },
    onError: () => toast.error(t('wifi.backendTestFailed')),
  })

  const networks = scanMutation.data?.ok ? scanMutation.data.networks : []
  const espError = status !== undefined && !status.ok ? status.error : null
  const isConnectingWifi = connectMutation.isPending

  const handleConnect = () => {
    if (!selected) return
    connectMutation.mutate({ ssid: selected.ssid, password: selected.secured ? password : '' })
  }

  if (!supported) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('wifi.title')}</CardTitle>
          <CardDescription>{t('wifi.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 rounded-md bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
            <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t('wifi.unsupportedBrowser')}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!connected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('wifi.title')}</CardTitle>
          <CardDescription>{t('wifi.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" disabled={connecting} onClick={() => void handleConnectDevice()}>
            <Usb className="mr-2 h-4 w-4" aria-hidden="true" />
            {connecting ? t('wifi.deviceConnecting') : t('wifi.deviceConnect')}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">{t('wifi.deviceConnectHint')}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('wifi.title')}</CardTitle>
          <CardDescription>{t('wifi.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!statusLoading && espError && (
            <div className="flex items-center gap-2 rounded-md bg-secondary/40 px-3 py-2 text-sm text-muted-foreground">
              <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
              {espError}
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

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={scanMutation.isPending}
              onClick={() => scanMutation.mutate()}
            >
              <RefreshCw className={scanMutation.isPending ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'} />
              {scanMutation.isPending ? t('wifi.scanning') : t('wifi.scan')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => void handleDisconnectDevice()}>
              {t('wifi.deviceDisconnect')}
            </Button>
          </div>

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
                          disabled={isConnectingWifi || (network.secured && password.length === 0)}
                          onClick={handleConnect}
                        >
                          {isConnectingWifi ? t('wifi.connecting') : t('wifi.connect')}
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

            <Button
              type="button"
              variant="outline"
              disabled={testMutation.isPending || !(backendStatus?.ok && backendStatus.fixed)}
              onClick={() => testMutation.mutate()}
            >
              {testMutation.isPending ? t('wifi.backendTesting') : t('wifi.backendTest')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('wifi.stationTitle')}</CardTitle>
          <CardDescription>{t('wifi.stationDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {stationStatus?.ok && (
            <div className="rounded-md bg-secondary/40 px-3 py-2 text-sm">
              {stationStatus.name.length > 0 ? (
                <span className="text-foreground">
                  {t('wifi.stationCurrentSet', { name: stationStatus.name })}
                </span>
              ) : (
                <span className="text-muted-foreground">{t('wifi.stationCurrentUnset')}</span>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="wifi-station-name">{t('wifi.stationLabel')}</Label>
            <Input
              id="wifi-station-name"
              value={stationName}
              onChange={(e) => setStationName(e.target.value)}
              placeholder={t('wifi.stationPlaceholder')}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={stationMutation.isPending || stationName.trim().length === 0}
              onClick={() => stationMutation.mutate(stationName)}
            >
              {stationMutation.isPending ? t('wifi.stationSaving') : t('wifi.stationSave')}
            </Button>

            {stationStatus?.ok && stationStatus.name.length > 0 && (
              <Button
                type="button"
                variant="outline"
                disabled={stationMutation.isPending}
                onClick={() => stationMutation.mutate('')}
              >
                {t('wifi.stationClear')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
