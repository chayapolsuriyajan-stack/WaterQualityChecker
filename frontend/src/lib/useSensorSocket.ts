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
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000
const POLL_INTERVAL_MS = 3_000
// ~3x the poll interval -- generous headroom over a remote-DB-backed poll's real latency
// (/live does 1 + 4xN_stations sequential Turso round-trips), avoiding flicker between
// "online" and "offline" during normal request-time variance.
const STALE_TIMEOUT_MS = POLL_INTERVAL_MS * 3

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
  /** Whether any station's reading has actually advanced within STALE_TIMEOUT_MS -- this
   * tracks data FRESHNESS, not just poll success. A poll can succeed every 3s while a
   * station's board is silent (backend/Turso fine, ESP32 dead); this flips false in that
   * case too, so the UI can't read "online" off a stale reading served on repeat. */
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
  // `/live`'s `timestamp` is epoch SECONDS (matching /history's convention). Expand to
  // milliseconds so callers can treat every reading's timestamp uniformly.
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
  const lastTimestampsRef = useRef<Record<string, number>>({})

  useEffect(() => {
    unmountedRef.current = false
    seededStationsRef.current = new Set()
    lastTimestampsRef.current = {}

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

        // A renamed station's old key simply stops appearing in /live's response, and the
        // new key appears -- prune anything no longer present so it doesn't linger forever.
        // Skip this when the response lists zero stations: that's indistinguishable from a
        // Turso outage (every storage helper degrades to an empty result rather than
        // raising), and an outage should leave last-known-good readings frozen on screen,
        // not wipe them -- `connected` going false (via the staleness check below) is what
        // signals the outage instead.
        if (live.stationNames.length > 0) {
          const known = new Set(live.stationNames)
          setStations((prev) => {
            const next: Record<string, StationSensorState> = {}
            for (const [name, state] of Object.entries(prev)) {
              if (known.has(name)) next[name] = state
              else {
                // Clean the two per-station refs alongside the pruned state entry -- leaving
                // a stale lastTimestampsRef entry behind would make this station's OLD
                // (pre-rename) timestamp still match if it's ever renamed back while its
                // board stays silent, permanently skipping it as "not fresh" and leaving it
                // absent from `stations` until a genuinely new reading arrives. Clearing
                // seededStationsRef too just means a re-appearing station re-seeds its
                // sparkline from /history once, same as a first-ever appearance.
                delete lastTimestampsRef.current[name]
                seededStationsRef.current.delete(name)
              }
            }
            return next
          })
        }

        // Only treat a poll as "fresh" -- applying the reading and re-arming the stale
        // timer -- when at least one station's timestamp actually advanced. Otherwise a
        // dead sensor (same reading repeated every poll) or a dead Turso (empty response)
        // would keep `connected` true forever instead of eventually going stale.
        let anyFresh = false
        for (const station of live.stationNames) {
          const entry = live.stations[station]
          if (!entry?.hasData || !entry.reading) continue
          const reading = normalizeReading(entry.reading as unknown as Record<string, unknown>)
          const readingTimestamp = reading.timestamp ?? Date.now()
          if (lastTimestampsRef.current[station] === readingTimestamp) continue
          lastTimestampsRef.current[station] = readingTimestamp
          anyFresh = true
          applyReading(reading)
        }
        if (anyFresh) {
          setConnected(true)
          armStaleTimer()
        }
      } catch {
        // A failed poll doesn't immediately flip `connected` false -- STALE_TIMEOUT_MS
        // (armed by the last FRESH poll, not merely the last successful one -- see the
        // anyFresh check above) already handles that, exactly like the old WS's stale-timer
        // did for a silently dead socket. This just tracks consecutive failures so
        // scheduleNext can back off instead of hammering a down backend.
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
