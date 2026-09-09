# Replace WebSocket live-push with HTTP polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `WS /ws/app` with a polled `GET /live` endpoint on the backend, and swap
`useSensorSocket.ts` from a WebSocket client to an HTTP poller on the frontend, so the live
dashboard works on Vercel's request-in/response-out serverless Python functions with no
persistent connection anywhere.

**Architecture:** One new backend route (`GET /live`) assembles the exact snapshot the old WS
prime frame used to build per-connection, now returned for every station on every call — built
entirely from sub-project #3's existing Turso helpers, no new storage code. `WS /ws/app`,
`ui_clients`, and the three `broadcast_*` functions are deleted. The frontend's
`useSensorSocket` hook keeps its `stations`/`connected` return shape (its two event-only
fields, `lastRename`/`lastAiReport`, are removed) but polls `GET /live` on a 3-second interval
instead of holding a socket open, reusing its existing offline/stale-timeout semantics.

**Tech Stack:** FastAPI (`main.py`), the Turso-backed `storage.py` helpers from sub-project #3,
React + TypeScript (`frontend/src/lib/useSensorSocket.ts`, `SensorProvider.tsx`, `api.ts`,
`types.ts`), TanStack Query (`AiReportCard.tsx`'s existing poll, untouched).

## Global Constraints

- No automated test suite exists in this repo (backend or frontend) — verification is manual:
  a standalone script/`TestClient` call for the backend endpoint, a real `npm run dev` +
  `python main.py` run for the frontend swap.
- Every new Turso call in `main.py` follows the existing pattern: `await
  asyncio.to_thread(storage.xxx, ...)`, gated behind `storage.enabled()` where the rest of the
  file already gates similar calls.
- Match the surrounding code's comment density and style in every file touched.
- The frontend's offline philosophy must not regress: on poll failure or staleness, `connected`
  flips false and the last real reading per station freezes on screen — never fabricated,
  never reset to zero/null. This is `useSensorSocket.ts`'s own stated design principle
  (see its top-of-file docstring) and must survive the WebSocket→polling swap unchanged.
- `frontend/src/lib/api.ts`'s `request()` helper and relative-path convention (no hardcoded
  host) must be reused for the new `getLive()` fetcher — never call `fetch()` directly outside
  that helper.

---

### Task 1: `main.py` — add `GET /live`, remove `/ws/app` and the broadcast mechanism

**Files:**
- Modify: `main.py`
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: `GET /live` returning
  `{"stationNames": string[], "stations": {[station]: {"hasData": bool, "reading": {...} | null, "stats": {...} | null}}}`
  where `reading` (when `hasData` is true) carries every field the old `sensor_update`
  broadcast payload carried: `station`, `timestamp` (epoch seconds), `temperature`,
  `turbidityRaw`, `turbidityNtu`, `turbidity`, `turbidityUnit`, `tds`, `tdsVoltage`, `ec`,
  `flowRate`, `waterUsageToday`. `stats` is `{paramKey: {"min": number, "max": number}}` for
  whichever of `temperature`/`turbidity`/`tds`/`flowRate` have at least one retained reading,
  or `null` if none do.

- [ ] **Step 1: Add the `GET /live` route**

Add this route near the existing `GET /history` route (same section of the file is a
reasonable place — both are "read current/recent state" endpoints):

```python
@app.get("/live")
async def get_live():
    """Snapshot of every station's current live state -- the Vercel-compatible replacement
    for the old WS /ws/app prime-frame + broadcast mechanism (removed below). Vercel's
    serverless Python functions can't hold a persistent connection open across requests, so
    the frontend polls this on an interval (useSensorSocket.ts) instead of listening for
    pushed frames. Returns the same per-station content the old prime frame built once per
    connection -- now just re-computed fresh on every call."""
    station_names = await asyncio.to_thread(storage.list_stations) if storage.enabled() else []
    stations: dict = {}
    today = _local_date()
    for station in station_names:
        last = await asyncio.to_thread(storage.get_latest_reading, station)
        if last is None:
            stations[station] = {"hasData": False, "reading": None, "stats": None}
            continue

        calib, station_mode, _severity = await _load_station_state(station)
        turbidity_adc = last.get("turbidity")
        ntu = last.get("turbidityNtu")
        if ntu is None and station_mode and turbidity_adc is not None:
            ntu = apply_turbidity(calib, turbidity_adc)

        stat_columns = {
            "temperature": "temperature",
            "turbidity": _turbidity_stat_column(calib, station_mode),
            "tds": "tds_ppm",
            "flowRate": "flow_rate",
        }
        # NOTE: since_ms=0 scans every retained row (up to 24h) on every call, once per
        # station polled here -- an accepted tradeoff of this migration's
        # no-in-process-caching design (see
        # docs/superpowers/specs/2026-09-08-station-state-turso-migration-design.md), not
        # free, but not a correctness bug. A future pass could maintain running min/max as
        # columns on station_state instead if this becomes a measured bottleneck. This is the
        # same query the old WS prime frame ran per connecting client; polling now runs it
        # per station per poll interval instead -- a materially higher call rate, tracked as
        # the same accepted tradeoff, not a new one this endpoint introduces.
        extremes = await asyncio.to_thread(
            storage.get_reading_extremes, station, 0, tuple(set(stat_columns.values()))
        )
        stats = {
            key: {"min": extremes[col]["min"], "max": extremes[col]["max"]}
            for key, col in stat_columns.items()
            if col in extremes
        }

        water_usage_today = (
            await asyncio.to_thread(storage.get_daily_usage, today, station)
            if storage.enabled()
            else None
        )

        stations[station] = {
            "hasData": True,
            "reading": {
                "station": station,
                "timestamp": last["timestamp"] // 1000,
                "temperature": last.get("temperature"),
                "turbidityRaw": turbidity_adc,
                "turbidityNtu": ntu,
                "turbidity": ntu if ntu is not None else turbidity_adc,
                "turbidityUnit": "NTU" if ntu is not None else "ADC",
                "tds": last.get("tds"),
                "tdsVoltage": last.get("tdsVoltage"),
                "ec": last.get("ec"),
                "flowRate": last.get("flowRate"),
                "waterUsageToday": water_usage_today,
            },
            "stats": stats or None,
        }

    return JSONResponse({"stationNames": station_names, "stations": stations})
```

- [ ] **Step 2: Remove `broadcast_sensor_update`, `broadcast_station_renamed`, `broadcast_ai_report`, and `ui_clients`/`ui_clients_lock`**

Delete these three function definitions entirely (currently right after `_local_date`):

```python
async def broadcast_sensor_update(payload: dict) -> None:
    ...

async def broadcast_station_renamed(old: str, new: str) -> None:
    ...

async def broadcast_ai_report(station: str, date: str, report: str) -> None:
    ...
```

Delete the module-level globals they used:

```python
ui_clients = set()
ui_clients_lock = asyncio.Lock()
```

- [ ] **Step 3: Remove the three call sites**

In `_generate_ai_report`, delete the line `await broadcast_ai_report(station, today, text)`
(immediately after `await asyncio.to_thread(storage.save_ai_report, today, station, text)`).

In `update_sensor` (`POST /update`), delete the line `await broadcast_sensor_update(payload)`
(immediately after the `print(f"Received sensor update: {payload}")` line). Leave the print
statement itself in place.

In `rename_station` (`POST /station/rename`), delete the line
`await broadcast_station_renamed(old, new)` (between the four `rename_*` storage calls and
the final `print(f"✏️ Renamed station...")`/`return` lines).

- [ ] **Step 4: Delete the `WS /ws/app` route entirely**

Delete the whole `websocket_app` function and its `@app.websocket("/ws/app")` decorator —
every line from `@app.websocket("/ws/app")` through the `finally: async with
ui_clients_lock: ui_clients.discard(websocket)` block at the end.

- [ ] **Step 5: Remove now-unused imports**

`WebSocket`, `WebSocketDisconnect` were imported from `fastapi` solely for the deleted route
— check whether either is still referenced anywhere else in `main.py` (grep the file) before
removing either from the `from fastapi import FastAPI, WebSocket, WebSocketDisconnect,
Request` line. If both are now unused, the import line becomes `from fastapi import FastAPI,
Request`.

- [ ] **Step 6: Update CLAUDE.md**

- The "Dashboard fan-out" bullet under "Architecture (main.py / FastAPI path)" currently
  reads: `**Dashboard fan-out** -- WS /ws/app: browser dashboards connect here and receive
  sensor_update JSON messages. Connected clients are tracked in the ui_clients set guarded by
  ui_clients_lock; disconnects are pruned during broadcast.` Replace it with something like:
  `**Dashboard fan-out** -- GET /live: browser dashboards poll this endpoint (every ~3s, see
  frontend's useSensorSocket.ts) instead of holding a WebSocket open -- Vercel's serverless
  Python functions can't keep a persistent connection alive across requests. Returns every
  station's current reading + stats in one response (storage.py's Turso-backed
  list_stations/get_latest_reading/get_reading_extremes).`
- The Multi-station support section's WS bullet (`**WS /ws/app**: on connect, sends one
  sensor_update prime frame per station...`) — replace with a description of `GET /live`
  returning every station's snapshot in one response on every poll, no separate prime-frame
  concept needed since every call already covers every station.
- The Frontend section's "Live data" bullet (mentions `useSensorSocket.ts` holding "the one
  shared /ws/app connection") — update to describe polling `GET /live` on an interval instead
  of a shared socket connection.
- Search the rest of the file for any other `/ws/app` or "WebSocket" reference (e.g. the AI
  daily report section's "broadcasts `{"type": "ai_report", ...}` over `/ws/app`" sentence,
  and `/station/rename`'s "broadcasts... over `/ws/app`" sentence) and update each to describe
  `GET /live` picking up the change on its next poll instead of an explicit broadcast.

- [ ] **Step 7: Verify**

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import ast; ast.parse(open('main.py', encoding='utf-8').read())"` — expect no output.

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import main"` from the repo root — expect the normal startup banner, no traceback (confirms no leftover reference to `ui_clients`/`broadcast_*`/`WebSocket`).

Write and run a standalone end-to-end script (scratchpad path, delete after) using
`starlette.testclient.TestClient` against a local file-backed Turso database, mirroring
sub-project #3's Task 4 verification pattern:

```python
import sys, os
sys.path.insert(0, r"C:\Users\Ace\Documents\projects\WaterQualityChecker")
os.chdir(r"C:\Users\Ace\Documents\projects\WaterQualityChecker")

import json
with open("webconfig.json", encoding="utf-8") as f:
    cfg = json.load(f)
cfg["tursoDatabaseUrl"] = "file:/tmp/verify_live_endpoint.db"
with open("webconfig.json", "w", encoding="utf-8") as f:
    json.dump(cfg, f)

from starlette.testclient import TestClient
import main

client = TestClient(main.app)

# No stations at all yet.
r = client.get("/live")
assert r.status_code == 200, r.text
body = r.json()
assert body == {"stationNames": [], "stations": {}}, body

# One station with a reading.
r = client.post("/update", json={"temperature": 22.5, "turbidity": 100, "tdsVoltage": 1.1, "station": "Inlet"})
assert r.status_code == 200, r.text

r = client.get("/live")
body = r.json()
assert body["stationNames"] == ["Inlet"], body
assert body["stations"]["Inlet"]["hasData"] is True, body
assert body["stations"]["Inlet"]["reading"]["temperature"] == 22.5, body
assert body["stations"]["Inlet"]["stats"]["temperature"] == {"min": 22.5, "max": 22.5}, body

# Confirm /ws/app is truly gone.
import httpx
try:
    with client.websocket_connect("/ws/app"):
        raise AssertionError("expected /ws/app to be gone")
except Exception:
    pass

print("Task 1 /live endpoint verification: ALL PASSED")
```

Run it, confirm the printed success line, then revert the test-only `webconfig.json` edit:
`git checkout -- webconfig.json`.

- [ ] **Step 8: Commit**

```bash
git add main.py CLAUDE.md
git commit -m "main.py: replace WS /ws/app with polled GET /live for Vercel compatibility"
```

---

### Task 2: Frontend — swap `useSensorSocket` from WebSocket to polling

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/lib/useSensorSocket.ts`
- Modify: `frontend/src/lib/SensorProvider.tsx`
- Modify: `frontend/src/components/dashboard/AiReportCard.tsx`

**Interfaces:**
- Consumes: `GET /live` (Task 1)
- Produces: `UseSensorSocketResult` narrows to `{ stations, connected }` (drops `lastRename`,
  `lastAiReport`) — every existing consumer of `stations`/`connected` (via
  `useSensorData()`/`useSelectedStationData()`) is unaffected.

- [ ] **Step 1: Add a `LiveResponse` type and `getLive()` fetcher**

In `frontend/src/lib/types.ts`, add (near `SensorReading`, since it reuses that shape):

```typescript
/** One station's entry in GET /live's response. */
export interface LiveStationState {
  hasData: boolean
  reading: SensorReading | null
  stats: Record<string, { min: number; max: number }> | null
}

/** GET /live's full response -- every station's current snapshot, polled on an interval
 * instead of pushed over a WebSocket (see useSensorSocket.ts). */
export interface LiveResponse {
  stationNames: string[]
  stations: Record<string, LiveStationState>
}
```

In `frontend/src/lib/api.ts`, add the import (extend the existing `import type { ... } from
'./types'` block with `LiveResponse`) and the fetcher, near `getHistory`:

```typescript
export function getLive(): Promise<LiveResponse> {
  return request<LiveResponse>('/live')
}
```

- [ ] **Step 2: Rewrite `useSensorSocket.ts`'s connection logic as polling**

Keep every helper function that doesn't touch the WebSocket itself unchanged: `emptySeries`,
`emptyStationState`, `pushSample`, `seriesFromHistory`, `mergeSeries`, `normalizeReading`. The
`SeriesParam`/`SeriesPoint`/`SensorSeries`/`StationSensorState` types are unchanged.

Remove `extractReading` entirely — a `GET /live` response's `reading` field is already a
`SensorReading`-shaped object needing only `normalizeReading`'s numeric-coercion pass (called
directly per-station below), not the message-envelope unwrapping `extractReading` existed
for (that unwrapping was specifically for the WS's several tolerated frame shapes, which no
longer exist).

Change the top-of-file docstring's second sentence (currently "On disconnect or stale data,
this freezes...") to say "live sensor readings polled from `/live`" instead of "over
`/ws/app`", keeping the rest of the philosophy paragraph intact.

Add a poll-interval constant alongside the existing ones:

```typescript
const POLL_INTERVAL_MS = 3_000
```

Replace `UseSensorSocketResult`'s interface to drop the two removed fields:

```typescript
export interface UseSensorSocketResult {
  /** Every station seen so far this session, keyed by SensorReading.station. A station
   * only appears here once its first reading (live or primed) has arrived -- there is no
   * pre-registration. */
  stations: Record<string, StationSensorState>
  /** Whether the last poll of /live succeeded -- this is polling health, not per-station; a
   * station can simply have gone quiet while polling itself keeps succeeding. */
  connected: boolean
}
```

Replace the whole `useSensorSocket` function body. Keep `seedStationHistory` and
`applyReading` exactly as they are today (both operate on a `SensorReading`, independent of
where it came from). Delete `applyStationRenamed` and its call site (no longer needed — see
the design spec's snapshot-reconciliation rationale: a renamed station's old key simply stops
appearing in the next `/live` response and the new key appears, handled by
`SensorProvider.tsx`'s existing "selection missing from `stationNames`" fallback, no explicit
rename-following required here). Delete `lastRename`/`lastAiReport` state and their setters.

Replace `connect`/`ws.onopen`/`ws.onmessage`/`ws.onclose`/`ws.onerror`/`scheduleReconnect`
and the `wsRef`/`reconnectTimerRef`/`reconnectAttemptRef` refs with a polling loop:

```typescript
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
```

Add `getLive` to the existing `import { getHistory } from './api'` line (becomes `import {
getHistory, getLive } from './api'`).

- [ ] **Step 3: Update `SensorProvider.tsx`**

Remove the `sensor.lastRename` branch from the `useEffect` that follows renames/falls back to
`stationNames[0]`. Replace:

```typescript
  useEffect(() => {
    if (sensor.lastRename && sensor.lastRename.old === selectedStation) {
      setSelectedStation(sensor.lastRename.new)
      return
    }
    if (stationNames.length > 0 && !stationNames.includes(selectedStation)) {
      setSelectedStationState(stationNames[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationNames.join('\u0000'), sensor.lastRename?.at])
```

with:

```typescript
  // If the persisted (or default) selection has never actually reported -- including
  // because it was just renamed server-side and the new name hasn't appeared in a poll yet
  // -- fall back to whichever station has. Renames now surface as an ordinary "the old name
  // stopped appearing, a new one appeared" transition (see useSensorSocket.ts's polling
  // design), not a distinct event, so there's nothing to special-case here beyond the
  // fallback every other disappearance already needed.
  useEffect(() => {
    if (stationNames.length > 0 && !stationNames.includes(selectedStation)) {
      setSelectedStationState(stationNames[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationNames.join('\u0000')])
```

Update the comment block above `SensorContext`/`SensorProvider` that says "Shares a single
`/ws/app` socket (and its simulation fallback timer) across the whole app" — change to
describe sharing one polling loop instead of a socket.

- [ ] **Step 4: Update `AiReportCard.tsx`**

Remove the `lastAiReport`-triggered effect and its dependency on `useSensorData()`:

Replace:

```typescript
  const { lastAiReport } = useSensorData()
  const queryClient = useQueryClient()
  const queryKey = ['ai-report', station] as const

  const { data, isLoading, isError, error } = useQuery({
    queryKey,
    queryFn: () => getAiReport(station),
    refetchInterval: REFETCH_INTERVAL_MS,
    retry: false,
  })

  // A live ai_report WS event for this station (generated by the midnight scheduler, or by
  // any connected dashboard's "Generate now" click) -- refetch instead of trusting the event
  // payload directly, so this stays the single source of truth main.py's GET /ai-report agrees with.
  useEffect(() => {
    if (lastAiReport && lastAiReport.station === station) {
      void queryClient.invalidateQueries({ queryKey })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAiReport?.at])
```

with:

```typescript
  const queryClient = useQueryClient()
  const queryKey = ['ai-report', station] as const

  const { data, isLoading, isError, error } = useQuery({
    queryKey,
    queryFn: () => getAiReport(station),
    refetchInterval: REFETCH_INTERVAL_MS,
    retry: false,
  })
```

Remove the now-unused `useEffect` import (check the file's other imports first — `useEffect`
may or may not still be needed elsewhere in this component; if this was its only use, drop it
from the `import { useEffect } from 'react'` line) and the now-unused `useSensorData` import
(`import { useSensorData } from '@/lib/SensorProvider'`) if this was its only use in the
file.

Update the file's top docstring, which currently says "a live `ai_report` WS event (see
useSensorSocket's `lastAiReport`) refreshes it immediately for every connected dashboard, not
just the one that triggered it" — replace with something like: "the 'Generate now' button's
own response refreshes it immediately for whichever browser clicked it; every other connected
dashboard picks up a fresh report on its next 5-minute poll."

- [ ] **Step 5: Verify**

Run: `cd frontend && npm run lint` — expect no new errors (in particular, no unused-import
warnings from the removed `lastRename`/`lastAiReport`/`extractReading`/`useEffect`/
`useSensorData` references).

Run: `cd frontend && npm run build` — expect a clean build (this also runs `tsc -b`, which
catches any leftover reference to the removed `UseSensorSocketResult` fields anywhere else in
the frontend — grep the `frontend/src` tree for `lastRename`/`lastAiReport` first and fix any
other consumer the build doesn't already catch).

Manual verification (no automated test suite exists for the frontend): with
`python main.py` running and `cd frontend && npm run dev`, open the dashboard and confirm
readings still update roughly every 3 seconds; stop `python main.py` and confirm the UI shows
its offline state within `STALE_TIMEOUT_MS` while the last reading stays frozen (not
reset); restart `python main.py` and confirm it recovers.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/types.ts frontend/src/lib/useSensorSocket.ts frontend/src/lib/SensorProvider.tsx frontend/src/components/dashboard/AiReportCard.tsx
git commit -m "frontend: swap useSensorSocket from WebSocket to polling GET /live"
```
