/**
 * React hook: live sensor readings polled from `/live`, with a rolling per-parameter
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
import { getHistory, getLive } from './api'
import type { HistoryRow, SensorReading } from './types'

const SPARKLINE_WINDOW_MS = 30_000
const STALE_TIMEOUT_MS = 5_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000
const POLL_INTERVAL_MS = 3_000

export type SeriesParam = 'temperature' | 'turbidity' | 'tds' | 'ec' | 'flow'

export type SeriesPoint = { t: number; v: number }

export type SensorSeries = Record<SeriesParam, SeriesPoint[]>

/** One station's live state: its latest reading plus its own rolling sparkline series.
 * Two stations never share a series -- a turbidity spike on one board must never bleed
 * into another board's sparkline. */
export interface StationSensorState {
  reading: SensorReading | null
  series: SensorSeries
}

export interface UseSensorSocketResult {
  /** Every station seen so far this session, keyed by SensorReading.station. A station
   * only appears here once its first reading (live or primed) has arrived -- there is no
   * pre-registration. */
  stations: Record<string, StationSensorState>
  /** Whether the last poll of /live succeeded -- this is polling health, not per-station; a
   * station can simply have gone quiet while polling itself keeps succeeding. */
  connected: boolean
}

export function emptySeries(): SensorSeries {
  return { temperature: [], turbidity: [], tds: [], ec: [], flow: [] }
}

function emptyStationState(): StationSensorState {
  return { reading: null, series: emptySeries() }
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
  // Mirrors the backend's own DEFAULT_STATION sentinel (main.py) -- a board with no
  // station name provisioned yet, or a pre-multi-station /update payload, omits the
  // field entirely, and this normalizes to the exact same single implicit station.
  const station = typeof obj.station === 'string' && obj.station.trim() ? obj.station : 'default'
  return {
    station,
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
  const [stations, setStations] = useState<Record<string, StationSensorState>>({})
  const [connected, setConnected] = useState(false)

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const failureCountRef = useRef(0)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountedRef = useRef(false)
  const seededStationsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    unmountedRef.current = false
    seededStationsRef.current = new Set()

    const seedStationHistory = (station: string) => {
      if (seededStationsRef.current.has(station)) return
      seededStationsRef.current.add(station)
      getHistory('5m', station)
        .then(({ rows }) => {
          if (unmountedRef.current) return
          const now = Date.now()
          setStations((prev) => {
            const existing = prev[station] ?? emptyStationState()
            return {
              ...prev,
              [station]: { ...existing, series: mergeSeries(existing.series, seriesFromHistory(rows, now), now) },
            }
          })
        })
        .catch(() => {
          // No history yet for this station -- its sparklines just start empty and fill in live.
        })
    }

    const applyReading = (r: SensorReading) => {
      const now = Date.now()
      setStations((prev) => {
        const existing = prev[r.station] ?? emptyStationState()
        return { ...prev, [r.station]: { reading: r, series: pushSample(existing.series, r, now) } }
      })
      seedStationHistory(r.station)
    }

    const armStaleTimer = () => {
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      staleTimerRef.current = setTimeout(() => {
        setConnected(false)
      }, STALE_TIMEOUT_MS)
    }

    const poll = async () => {
      if (unmountedRef.current) return
      try {
        const live = await getLive()
        if (unmountedRef.current) return
        failureCountRef.current = 0
        setConnected(true)
        armStaleTimer()
        for (const station of live.stationNames) {
          const entry = live.stations[station]
          if (!entry?.hasData || !entry.reading) continue
          applyReading(normalizeReading(entry.reading as unknown as Record<string, unknown>))
        }
      } catch {
        // A failed poll doesn't immediately flip `connected` false -- STALE_TIMEOUT_MS
        // (armed by the last successful poll) already handles that, exactly like the old
        // WS's stale-timer did for a silently dead socket. This just tracks consecutive
        // failures so scheduleNext can back off instead of hammering a down backend.
        failureCountRef.current += 1
      } finally {
        scheduleNext()
      }
    }

    const scheduleNext = () => {
      if (unmountedRef.current) return
      const failures = failureCountRef.current
      const delay = failures === 0
        ? POLL_INTERVAL_MS
        : Math.min(RECONNECT_BASE_MS * 2 ** (failures - 1), RECONNECT_MAX_MS)
      pollTimerRef.current = setTimeout(poll, delay)
    }

    poll()

    return () => {
      unmountedRef.current = true
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
    }
  }, [])

  return { stations, connected }
}
