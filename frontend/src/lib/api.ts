/**
 * Relative-path fetchers for the Aqua Monitor backend (main.py). All paths are
 * relative so the app works same-origin whether served at / in prod or
 * proxied in dev (see vite.config.ts). Never hardcode a host here.
 */
import type { CalibrationState, FlowUsageResponse, HistoryRow, HistoryWindow } from './types'

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

export function getHistory(window: HistoryWindow): Promise<HistoryResponse> {
  return request<HistoryResponse>(`/history?window=${encodeURIComponent(window)}`)
}

export function getCalibration(): Promise<CalibrationState> {
  return request<CalibrationState>('/calibration')
}

export type CalibrationSensor = 'turbidity' | 'tds' | 'flow'

export interface CapturePointArgs {
  sensor: CalibrationSensor
  reference: number
  label?: string
  raw?: number
}

export function capturePoint(args: CapturePointArgs): Promise<CalibrationState> {
  return request<CalibrationState>('/calibration/capture', {
    method: 'POST',
    body: JSON.stringify(args),
  })
}

export interface DeletePointArgs {
  sensor: CalibrationSensor
  index: number
}

export function deletePoint(args: DeletePointArgs): Promise<CalibrationState> {
  return request<CalibrationState>('/calibration/point', {
    method: 'DELETE',
    body: JSON.stringify(args),
  })
}

export function saveCalibration(): Promise<CalibrationState> {
  return request<CalibrationState>('/calibration/save', { method: 'POST' })
}

export function resetCalibration(sensor: CalibrationSensor): Promise<CalibrationState> {
  return request<CalibrationState>('/calibration/reset', {
    method: 'POST',
    body: JSON.stringify({ sensor }),
  })
}

export function setCalibrationMode(enabled: boolean): Promise<CalibrationState> {
  return request<CalibrationState>('/calibration/mode', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })
}

export function getFlowUsage(days = 14): Promise<FlowUsageResponse> {
  return request<FlowUsageResponse>(`/flow/usage?days=${encodeURIComponent(String(days))}`)
}

export function resetFlowUsageToday(): Promise<{ ok: boolean; today: number }> {
  return request('/flow/reset-today', { method: 'POST' })
}
