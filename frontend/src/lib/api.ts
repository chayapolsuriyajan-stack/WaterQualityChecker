/**
 * Relative-path fetchers for the Aqua Monitor backend (main.py). All paths are
 * relative so the app works same-origin whether served at / in prod or
 * proxied in dev (see vite.config.ts). Never hardcode a host here.
 */
import type {
  CalibrationState,
  FlowUsageResponse,
  HistoryRow,
  HistoryWindow,
  WifiBackendStatus,
  WifiNetwork,
  WifiStatus,
} from './types'

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${init?.method ?? 'GET'} ${input} failed: ${res.status} ${text}`)
  }
  // Some endpoints (e.g. POST /calibration/mode) may return no body.
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return undefined as unknown as T
  }
  return (await res.json()) as T
}

export interface HistoryResponse {
  rows: HistoryRow[]
  windowSeconds: number
  source: string
}

export function getHistory(window: HistoryWindow, station: string): Promise<HistoryResponse> {
  return request<HistoryResponse>(
    `/history?window=${encodeURIComponent(window)}&station=${encodeURIComponent(station)}`,
  )
}

export function getCalibration(station: string): Promise<CalibrationState> {
  return request<CalibrationState>(`/calibration?station=${encodeURIComponent(station)}`)
}

export type CalibrationSensor = 'turbidity' | 'tds' | 'flow'

export interface CapturePointArgs {
  sensor: CalibrationSensor
  reference: number
  label?: string
  raw?: number
}

export function capturePoint(args: CapturePointArgs, station: string): Promise<CalibrationState> {
  return request<CalibrationState>(`/calibration/capture?station=${encodeURIComponent(station)}`, {
    method: 'POST',
    body: JSON.stringify(args),
  })
}

export interface DeletePointArgs {
  sensor: CalibrationSensor
  index: number
}

export function deletePoint(args: DeletePointArgs, station: string): Promise<CalibrationState> {
  return request<CalibrationState>(`/calibration/point?station=${encodeURIComponent(station)}`, {
    method: 'DELETE',
    body: JSON.stringify(args),
  })
}

export function saveCalibration(station: string): Promise<CalibrationState> {
  return request<CalibrationState>(`/calibration/save?station=${encodeURIComponent(station)}`, { method: 'POST' })
}

export function resetCalibration(sensor: CalibrationSensor, station: string): Promise<CalibrationState> {
  return request<CalibrationState>(`/calibration/reset?station=${encodeURIComponent(station)}`, {
    method: 'POST',
    body: JSON.stringify({ sensor }),
  })
}

export function setCalibrationMode(enabled: boolean, station: string): Promise<CalibrationState> {
  return request<CalibrationState>(`/calibration/mode?station=${encodeURIComponent(station)}`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })
}

export function getFlowUsage(station: string, days = 14): Promise<FlowUsageResponse> {
  return request<FlowUsageResponse>(
    `/flow/usage?days=${encodeURIComponent(String(days))}&station=${encodeURIComponent(station)}`,
  )
}

export function resetFlowUsageToday(station: string): Promise<{ ok: boolean; today: number }> {
  return request(`/flow/reset-today?station=${encodeURIComponent(station)}`, { method: 'POST' })
}

/**
 * WiFi provisioning over USB (see wifi_serial.py / main.py's /wifi/* routes). Unlike every
 * other fetcher in this file, a "the ESP32 isn't on USB" response (a plain, expected outcome,
 * not a bug) comes back as a non-2xx HTTP status with a `{error}` body -- so these three
 * report failure via a discriminated-union return instead of `request()`'s throw-on-non-ok,
 * matching how push.ts's sendTestPush already handles this same shape for /push/test.
 */
export type WifiResult<T> = ({ ok: true } & T) | { ok: false; error: string }

async function requestWifi<T>(input: string, init?: RequestInit): Promise<WifiResult<T>> {
  try {
    const res = await fetch(input, {
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    })
    const data = (await res.json().catch(() => null)) as (T & { ok?: boolean }) | { error?: string } | null
    if (!res.ok) {
      const error = (data as { error?: string } | null)?.error ?? `request failed (${res.status})`
      return { ok: false, error }
    }
    return { ok: true, ...(data as T) }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export function getWifiStatus(): Promise<WifiResult<WifiStatus>> {
  return requestWifi<WifiStatus>('/wifi/status')
}

export function scanWifiNetworks(): Promise<WifiResult<{ networks: WifiNetwork[] }>> {
  return requestWifi<{ networks: WifiNetwork[] }>('/wifi/scan', { method: 'POST' })
}

export function connectWifi(ssid: string, password: string): Promise<WifiResult<{ ip: string }>> {
  return requestWifi<{ ip: string }>('/wifi/connect', {
    method: 'POST',
    body: JSON.stringify({ ssid, password }),
  })
}

export function getWifiBackend(): Promise<WifiResult<WifiBackendStatus>> {
  return requestWifi<WifiBackendStatus>('/wifi/backend')
}

/**
 * Has the ESP32 itself round-trip a GET against whatever backend it's currently configured to
 * use (see main.py's GET /update/health) -- exercises the real WiFi/DNS/TLS/API-key path the
 * board's actual /update POSTs take, not just whether this machine can reach the host.
 * `reachable: false` (httpCode 0) means a connection-level failure (DNS/TCP/TLS/no backend
 * configured); `reachable: true` with a non-2xx `httpCode` means the host answered but
 * rejected the request (e.g. a wrong API key -> 401).
 */
export function testWifiBackend(): Promise<
  WifiResult<{ reachable: boolean; httpCode: number; detail: string }>
> {
  return requestWifi<{ reachable: boolean; httpCode: number; detail: string }>('/wifi/backend/test', {
    method: 'POST',
  })
}

/** Pass host: '' to clear the override and go back to same-LAN auto-discovery. */
export function setWifiBackend(
  host: string,
  apiKey: string,
  useHttps: boolean,
): Promise<WifiResult<{ host: string }>> {
  return requestWifi<{ host: string }>('/wifi/backend', {
    method: 'POST',
    body: JSON.stringify({ host, apiKey, useHttps }),
  })
}
