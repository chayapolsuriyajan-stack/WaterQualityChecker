/**
 * React hook: live sensor readings over `/ws/app`, with a rolling per-parameter
 * sample history for sparklines. On disconnect or stale data, this freezes at the
 * last real reading and flips `connected` to false rather than fabricating plausible-
 * looking numbers -- a real water-quality monitor must show an honest "offline" state,
 * not synthetic noise that could be mistaken for the water actually changing. (An
 * earlier version of this hook had a random-data simulation fallback for demo/dev
 * purposes; removed once the full ESP32 -> backend -> Sheets -> frontend chain was
 * wired to real hardware, since it made a real sensor outage indistinguishable from
 * normal operation.)
 */
import { useEffect, useRef, useState } from 'react'
import { getHistory } from './api'
import type { HistoryRow, SensorReading } from './types'

const SPARKLINE_WINDOW_MS = 30_000
const STALE_TIMEOUT_MS = 5_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000

export type SeriesParam = 'temperature' | 'turbidity' | 'tds' | 'ec' | 'flow'

export type SeriesPoint = { t: number; v: number }

export type SensorSeries = Record<SeriesParam, SeriesPoint[]>

export interface UseSensorSocketResult {
  reading: SensorReading | null
  connected: boolean
  series: SensorSeries
}

function emptySeries(): SensorSeries {
  return { temperature: [], turbidity: [], tds: [], ec: [], flow: [] }
}

function pushSample(series: SensorSeries, reading: SensorReading, now: number): SensorSeries {
  const next: SensorSeries = {
    temperature: [...series.temperature, { t: now, v: reading.temperature }],
    turbidity: [...series.turbidity, { t: now, v: reading.turbidityNtu ?? reading.turbidity }],
    tds: [...series.tds, ...(reading.tds != null ? [{ t: now, v: reading.tds }] : [])],
    ec: [...series.ec, ...(reading.ec != null ? [{ t: now, v: reading.ec }] : [])],
    flow: [...series.flow, ...(reading.flowRate != null ? [{ t: now, v: reading.flowRate }] : [])],
  }
  const cutoff = now - SPARKLINE_WINDOW_MS
  for (const key of Object.keys(next) as SeriesParam[]) {
    next[key] = next[key].filter((p) => p.t >= cutoff)
  }
  return next
}

/** Maps `/history` rows onto the same series shape `pushSample` builds live, so a page
 * reload doesn't start every sparkline empty and wait ~30s for it to refill from scratch. */
function seriesFromHistory(rows: HistoryRow[], now: number): SensorSeries {
  const cutoff = now - SPARKLINE_WINDOW_MS
  const next = emptySeries()
  for (const row of rows) {
    if (typeof row.timestamp !== 'number' || row.timestamp < cutoff) continue
    if (typeof row.temperature === 'number') next.temperature.push({ t: row.timestamp, v: row.temperature })
    const turbidityValue = row.turbidityNtu ?? row.turbidity
    if (typeof turbidityValue === 'number') next.turbidity.push({ t: row.timestamp, v: turbidityValue })
    if (typeof row.tds === 'number') next.tds.push({ t: row.timestamp, v: row.tds })
    if (typeof row.ec === 'number') next.ec.push({ t: row.timestamp, v: row.ec })
    if (typeof row.flowRate === 'number') next.flow.push({ t: row.timestamp, v: row.flowRate })
  }
  return next
}

/** Combines the history seed with whatever live points may already have landed while the
 * `/history` fetch was in flight, de-duplicated by timestamp and re-sorted ascending. */
function mergeSeries(live: SensorSeries, seeded: SensorSeries, now: number): SensorSeries {
  const cutoff = now - SPARKLINE_WINDOW_MS
  const next = emptySeries()
  for (const key of Object.keys(next) as SeriesParam[]) {
    const seen = new Set<number>()
    const combined: SeriesPoint[] = []
    for (const p of [...seeded[key], ...live[key]]) {
      if (p.t < cutoff || seen.has(p.t)) continue
      seen.add(p.t)
      combined.push(p)
    }
    combined.sort((a, b) => a.t - b.t)
    next[key] = combined
  }
  return next
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
    flowRate: numOrNull(obj.flowRate),
    waterUsageToday: numOrNull(obj.waterUsageToday),
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
  const lastMessageAtRef = useRef<number>(0)
  const unmountedRef = useRef(false)

  useEffect(() => {
    unmountedRef.current = false

    const applyReading = (r: SensorReading) => {
      const now = Date.now()
      setReading(r)
      setSeries((prev) => pushSample(prev, r, now))
    }

    // No data for STALE_TIMEOUT_MS => mark offline. Deliberately does NOT touch `reading` or
    // `series`: the last real values stay on screen (frozen) rather than being replaced with
    // fabricated numbers, so a genuine sensor outage reads as "stale", not as new data.
    const armStaleTimer = () => {
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      staleTimerRef.current = setTimeout(() => {
        setConnected(false)
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
        lastMessageAtRef.current = Date.now()
        armStaleTimer()
      }

      ws.onmessage = (event) => {
        lastMessageAtRef.current = Date.now()
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

    // Seed the sparklines from recent history so a reload shows the last few minutes
    // immediately instead of a blank chart that only fills back in as new live readings
    // trickle in over the next ~30s. Runs alongside connect(), not before it -- a live
    // point that lands first is safe, mergeSeries de-dupes by timestamp either way.
    getHistory('5m')
      .then(({ rows }) => {
        if (unmountedRef.current) return
        const now = Date.now()
        setSeries((prev) => mergeSeries(prev, seriesFromHistory(rows, now), now))
      })
      .catch(() => {
        // No history yet (fresh server, or the short window's live buffer is still empty)
        // -- sparklines just start empty and fill in live, same as before this seeding existed.
      })

    connect()

    return () => {
      unmountedRef.current = true
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [])

  return { reading, connected, series }
}
