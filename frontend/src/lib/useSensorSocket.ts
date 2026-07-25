/**
 * React hook: live sensor readings over `/ws/app`, with a rolling per-parameter
 * sample history for sparklines and a simulation fallback when disconnected or
 * stale (per AQUA_MONITOR_PLAN.md "useSensorSocket").
 */
import { useEffect, useRef, useState } from 'react'
import type { SensorReading } from './types'

const SPARKLINE_WINDOW_MS = 30_000
const STALE_TIMEOUT_MS = 5_000
const SIMULATION_INTERVAL_MS = 2_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000

export type SeriesParam = 'temperature' | 'turbidity' | 'tds' | 'ec'

export type SeriesPoint = { t: number; v: number }

export type SensorSeries = Record<SeriesParam, SeriesPoint[]>

export interface UseSensorSocketResult {
  reading: SensorReading | null
  connected: boolean
  series: SensorSeries
}

function emptySeries(): SensorSeries {
  return { temperature: [], turbidity: [], tds: [], ec: [] }
}

function pushSample(series: SensorSeries, reading: SensorReading, now: number): SensorSeries {
  const next: SensorSeries = {
    temperature: [...series.temperature, { t: now, v: reading.temperature }],
    turbidity: [...series.turbidity, { t: now, v: reading.turbidityNtu ?? reading.turbidity }],
    tds: [...series.tds, ...(reading.tds != null ? [{ t: now, v: reading.tds }] : [])],
    ec: [...series.ec, ...(reading.ec != null ? [{ t: now, v: reading.ec }] : [])],
  }
  const cutoff = now - SPARKLINE_WINDOW_MS
  for (const key of Object.keys(next) as SeriesParam[]) {
    next[key] = next[key].filter((p) => p.t >= cutoff)
  }
  return next
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function simulatedReading(): SensorReading {
  const turbidityRaw = randomBetween(1500, 1900)
  const tds = randomBetween(150, 250)
  return {
    temperature: randomBetween(24, 28),
    turbidity: turbidityRaw,
    turbidityNtu: null,
    turbidityRaw,
    turbidityUnit: 'ADC',
    tds,
    tdsVoltage: tds / 500, // plausible placeholder, not used for calibration
    ec: tds * 2,
    timestamp: Date.now(),
  }
}

/** Normalizes any of the tolerated WS message shapes into a SensorReading, or null. */
function extractReading(data: unknown): SensorReading | null {
  if (!data || typeof data !== 'object') return null
  const msg = data as Record<string, unknown>

  // { type: 'sensor_update', payload: {...} }
  // Covers both real broadcasts AND the connect-time "prime" frame, which is sent in this
  // same envelope (see main.py websocket_app): { type: 'sensor_update', payload: { hasData,
  // stats, lastTimestamp, [...last reading fields if any]} }. When hasData is false (no
  // reading has ever been recorded), or the payload otherwise carries no actual reading
  // (no `temperature` key), there is nothing to show yet — return null rather than letting
  // normalizeReading coerce the missing fields to fabricated zeros.
  if (msg.type === 'sensor_update' && msg.payload && typeof msg.payload === 'object') {
    const payload = msg.payload as Record<string, unknown>
    if (payload.hasData === false || !('temperature' in payload)) return null
    return normalizeReading(payload)
  }

  // Prime frame arriving unwrapped: { hasData, lastTimestamp, last: {...} } (or payload
  // under `reading`).
  if ('hasData' in msg || 'lastTimestamp' in msg) {
    const last = (msg.last ?? msg.reading ?? msg.payload) as Record<string, unknown> | undefined
    if (msg.hasData === false || !last || !('temperature' in last)) return null
    return normalizeReading(last)
  }

  // Flat payload with recognizable sensor fields.
  if ('temperature' in msg || 'turbidity' in msg || 'tds' in msg) {
    return normalizeReading(msg)
  }

  return null
}

function normalizeReading(obj: Record<string, unknown>): SensorReading {
  const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null)
  const tds = numOrNull(obj.tds)
  const ec = numOrNull(obj.ec) ?? (tds != null ? tds * 2 : null)
  // The prime frame's `timestamp` is epoch SECONDS (matching /history's convention); live
  // `sensor_update` broadcasts and history_buffer both use epoch MILLISECONDS. Normalize
  // both onto milliseconds.
  const rawTimestamp = typeof obj.timestamp === 'number' ? obj.timestamp : Date.now()
  const timestamp = rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp
  return {
    temperature: num(obj.temperature),
    turbidity: num(obj.turbidity),
    turbidityNtu: numOrNull(obj.turbidityNtu),
    turbidityRaw: num(obj.turbidityRaw, num(obj.turbidity)),
    turbidityUnit: obj.turbidityUnit === 'NTU' ? 'NTU' : 'ADC',
    tds,
    tdsVoltage: num(obj.tdsVoltage),
    ec,
    timestamp,
  }
}

export function useSensorSocket(): UseSensorSocketResult {
  const [reading, setReading] = useState<SensorReading | null>(null)
  const [connected, setConnected] = useState(false)
  const [series, setSeries] = useState<SensorSeries>(emptySeries())

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const simulationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastMessageAtRef = useRef<number>(0)
  const unmountedRef = useRef(false)

  useEffect(() => {
    unmountedRef.current = false

    const applyReading = (r: SensorReading) => {
      const now = Date.now()
      setReading(r)
      setSeries((prev) => pushSample(prev, r, now))
    }

    const stopSimulation = () => {
      if (simulationTimerRef.current) {
        clearInterval(simulationTimerRef.current)
        simulationTimerRef.current = null
      }
    }

    const startSimulation = () => {
      if (simulationTimerRef.current) return
      setConnected(false)
      simulationTimerRef.current = setInterval(() => {
        applyReading(simulatedReading())
      }, SIMULATION_INTERVAL_MS)
    }

    const armStaleTimer = () => {
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      staleTimerRef.current = setTimeout(() => {
        startSimulation()
      }, STALE_TIMEOUT_MS)
    }

    const connect = () => {
      if (unmountedRef.current) return

      const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
      const url = `${protocol}://${location.host}/ws/app`
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        reconnectAttemptRef.current = 0
        setConnected(true)
        stopSimulation()
        lastMessageAtRef.current = Date.now()
        armStaleTimer()
      }

      ws.onmessage = (event) => {
        lastMessageAtRef.current = Date.now()
        stopSimulation()
        setConnected(true)
        armStaleTimer()
        try {
          const data = JSON.parse(event.data)
          const parsed = extractReading(data)
          if (parsed) applyReading(parsed)
        } catch {
          // Ignore malformed frames.
        }
      }

      ws.onclose = () => {
        setConnected(false)
        startSimulation()
        scheduleReconnect()
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    const scheduleReconnect = () => {
      if (unmountedRef.current) return
      if (reconnectTimerRef.current) return
      const attempt = reconnectAttemptRef.current
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
      reconnectAttemptRef.current = attempt + 1
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        connect()
      }, delay)
    }

    connect()

    return () => {
      unmountedRef.current = true
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      stopSimulation()
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [])

  return { reading, connected, series }
}
