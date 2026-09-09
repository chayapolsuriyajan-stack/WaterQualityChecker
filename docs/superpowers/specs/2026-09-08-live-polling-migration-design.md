# Replace WebSocket live-push with HTTP polling — design spec

Date: 2026-09-08
Status: approved, ready for planning
Branch: `feature/vercel-migration`

## Context

Sub-project #4 of the Vercel migration (see sub-projects #1-3's specs for the full 6-part
decomposition). Vercel's Python serverless functions are request-in/response-out — each
invocation runs, responds, and ends; there is no way to hold a `WS /ws/app` connection open
across requests the way the current always-on `python main.py` process does. This sub-project
replaces the WebSocket entirely, on both backend and frontend, with HTTP polling — chosen
over a third-party realtime service (extra cost/account/failure-mode for a feature this app
can tolerate a few seconds of latency on) and over Server-Sent Events (Vercel's standard
Python runtime has the same non-persistent-connection constraint SSE would run into, and
would force `main.py` off a single plain FastAPI app to make streaming work).

This lands in one sub-project rather than split across the original #4/#6 boundary: leaving
`/ws/app` removed but the frontend still expecting it (the original decomposition's
implied sequencing) would break the live dashboard for however long #6 takes to catch up.
Both sides move together here; sub-project #6 still has plenty left (API base URL, CORS,
mixed-content HTTPS) once this sub-project's polling swap is in place.

## Backend: one new endpoint, `GET /live`

Returns every station's current snapshot in one response — the same content the old WS
prime frame sent once per connection, now re-fetchable on an interval instead of pushed:

```json
{
  "stationNames": ["default", "Inlet"],
  "stations": {
    "default": {
      "hasData": true,
      "reading": { "...": "same fields the old sensor_update payload carried" },
      "stats": { "temperature": {"min": 20.1, "max": 24.3}, "...": "..." }
    },
    "Inlet": { "hasData": false, "reading": null, "stats": null }
  }
}
```

Built entirely from existing sub-project #3 Turso helpers — `storage.list_stations()`,
`storage.get_latest_reading(station)`, `storage.get_reading_extremes(...)`,
`_load_station_state(station)` for the turbidity NTU/raw column choice (reusing
`_turbidity_stat_column`) — the same assembly the WS prime-frame loop already did, just
moved into an HTTP route instead of firing once per new socket connection. No new storage
code.

`WS /ws/app`, the `ui_clients`/`ui_clients_lock` set, and
`broadcast_sensor_update`/`broadcast_station_renamed`/`broadcast_ai_report` are deleted
outright — `/update` and `/station/rename` stop calling them (nothing else does once the
socket is gone).

## Rename & AI-report propagation: dropped in favor of snapshot reconciliation

No replacement event mechanism for `station_renamed`/`ai_report` — polling `/live`'s full
snapshot makes them unnecessary:

- **Rename**: the frontend hook replaces its whole `stations` map with each poll's response.
  A renamed station's old key simply stops appearing and the new key appears, a few seconds
  later (one poll interval) rather than instantly. `SensorProvider`'s persisted
  `selectedStation` already has a fallback for "selection missing from `stationNames`" (falls
  to `stationNames[0]`) — losing the explicit rename-follow branch just means that fallback
  path handles renames too, indistinguishable from any other reason a station stopped
  appearing.
- **AI report**: `AiReportCard` keeps its existing independent 5-minute `GET /ai-report`
  poll unchanged. The "Generate now" button already invalidates its own query on a successful
  response, so the initiating browser updates instantly regardless of this change — only
  *other* connected browsers wait up to 5 minutes to see a fresh report, exactly as they
  already do for the midnight-scheduler-generated case today.

## Frontend: `useSensorSocket` becomes a poller

Same exported shape minus the two removed fields: `{ stations, connected }`. Internally,
`WebSocket`/`onopen`/`onmessage`/`onclose` and the reconnect-backoff logic are replaced by a
`setInterval` calling `GET /live`; the existing `RECONNECT_BASE_MS`/`RECONNECT_MAX_MS`
backoff constants are reused for consecutive fetch failures instead of socket reconnects.
Offline semantics are unchanged: `connected` flips false after `STALE_TIMEOUT_MS` with no
successful poll, and the last real reading per station stays frozen on screen — never
fabricated — matching this hook's existing documented philosophy.

`lastRename`/`lastAiReport` are removed from `UseSensorSocketResult` (not kept as
always-null placeholders — no dead API surface). Their two call sites are updated in this
same sub-project:
- `SensorProvider.tsx`'s `useEffect` drops the `sensor.lastRename` branch, keeping only the
  "selection not in `stationNames` → fall back to `stationNames[0]`" branch it already has.
- `AiReportCard.tsx` drops the `lastAiReport`-triggered `queryClient.invalidateQueries` effect
  and its `useSensorData()` import of `lastAiReport` — the 5-minute `refetchInterval` and the
  "Generate now" mutation's own `invalidateQueries` on success are untouched and already
  sufficient.

**Poll interval**: 3 seconds (close to the firmware's 2s ingestion cadence, with a little
slack so a poll and a reading don't have to race every single time) — a plain constant next
to the existing `SPARKLINE_WINDOW_MS`/`STALE_TIMEOUT_MS` constants, easy to retune later.

`seedStationHistory`'s `getHistory('5m', station)` call on first-seen-station is unchanged —
it already seeds sparklines from `/history`, orthogonal to how live updates now arrive.

## Non-goals

- Frontend API base URL / CORS / mixed-content HTTPS handling — sub-project #6.
- Restructuring `main.py` for Vercel's function-per-file conventions — sub-project #5.
- Web Push notifications — an entirely separate outbound mechanism (`/push/*`,
  `pywebpush`), untouched by this change; it never went through `/ws/app`.
- Changing `/live`'s poll interval per-tab-visibility (e.g. pausing when the tab is
  backgrounded) — not requested, can be added later without touching the backend.

## Testing

No automated test suite exists in this repo (backend or frontend). Backend verification:
exercise `GET /live` against a real/local Turso database and confirm its shape matches a
station with data and one without. Frontend verification: manual — run `npm run dev` against
`python main.py`, confirm the dashboard still updates roughly every 3s, confirm the
"offline" state still appears when the backend is stopped, confirm a station rename (via the
admin UI) still reaches a second open browser tab within one poll interval.
