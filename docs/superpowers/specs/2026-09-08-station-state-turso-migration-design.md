# Migrate per-station in-memory state to Turso — design spec

Date: 2026-09-08
Status: approved, ready for planning
Branch: `feature/vercel-migration`

## Context

Sub-project #3 of the Vercel migration (see sub-project #1/#2 specs for the full 6-part
decomposition). `main.py` currently holds 9 in-memory dicts keyed by station name
(`PER_STATION_MAPS`: `history_buffer`, `sensor_stats`, `last_severity`, `calibration`,
`calibration_mode`, `latest_raw`, `_raw_buffers`, `_daily_usage_totals`, `_daily_stats`,
`_daily_breach_counts`), plus a `_daily_usage_seeded` set and `calibration.json`/local
filesystem persistence for calibration. None of this survives a serverless invocation
boundary — every one of these needs to either move to Turso or be eliminated as a
now-unnecessary in-memory cache.

## Core architectural decision: a `readings` table replaces 4 of the 9 structures

Rather than migrating each structure 1:1, most of them are actually *derived views* over
recent reading history — which `main.py` currently avoids storing durably at all (relies on
in-memory + Google Sheets, a design that made sense for a persistent process, not a stateless
one). Adding one `readings` table to Turso collapses:

- `history_buffer` (recent-window `/history` answers, WS prime frames) → `SELECT ... WHERE
  station = ? AND ts_ms >= ? ORDER BY ts_ms`
- `sensor_stats` (since-server-start min/max) → `SELECT MIN(x), MAX(x) ...` (redefined as
  "since oldest retained row" — see Retention below; "since server start" has no meaning once
  there's no persistent server)
- `latest_raw`/`_raw_buffers` (last-5-readings average for calibration capture) → `SELECT ...
  ORDER BY ts_ms DESC LIMIT 5`
- `_daily_stats`/`_daily_breach_counts` (since-midnight AI-report rollup) → `SELECT ... WHERE
  station = ? AND ts_ms >= <local midnight>`

Google Sheets remains the long-term/exportable archive; Turso's `readings` table takes over
the role the in-memory buffer used to play (fast, recent-window answers) — see Retention.

## `station_state` table replaces the remaining structures

`last_severity` (breach edge-detection) and `calibration`/`calibration_mode` are genuinely
stateful, not derivable from reading history — these get one row per station:

```sql
CREATE TABLE IF NOT EXISTS station_state (
    station             TEXT PRIMARY KEY,
    calibration_json    TEXT NOT NULL,   -- same per-station shape calibration.json already used
    calibration_mode    INTEGER NOT NULL DEFAULT 0,
    last_severity_json  TEXT NOT NULL DEFAULT '{}'
);
```

`calibration.json`'s file-based load/migrate-on-startup logic is retired entirely — this table
is the only calibration store once this sub-project lands.

## `readings` schema

```sql
CREATE TABLE IF NOT EXISTS readings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    station        TEXT NOT NULL,
    ts_ms          INTEGER NOT NULL,
    temperature    REAL,
    turbidity_raw  REAL,
    turbidity_ntu  REAL,
    tds_voltage    REAL,
    tds_ppm        REAL,
    ec             REAL,
    flow_pulses    REAL,
    flow_rate      REAL
);
CREATE INDEX IF NOT EXISTS idx_readings_station_ts ON readings(station, ts_ms);
```

Field set matches `STAT_KEYS`/`PUSH_PARAMS`/the existing `/update` payload shape (`main.py:249,
709`), split into raw vs. calibrated where the current payload already does (`turbidityRaw`/
`turbidityNtu`, `tdsVoltage`/`tds`).

## Retention

Unbounded growth isn't acceptable at a 2s-per-station write cadence. Prune rows older than 24
hours (matching `HISTORY_WINDOWS`' longest live option) — a simple `DELETE FROM readings WHERE
ts_ms < ?` run opportunistically on a fraction of `/update` calls (e.g. every ~100th write, a
cheap probabilistic approach avoiding a separate scheduler), consistent with this codebase's
existing "no extra background infrastructure where a simple inline check suffices" style
(mirrors `_add_daily_usage`'s own lazy date-rollover check). Anything older than 24h is only
available via the existing Google Sheets tier, exactly as today's `/history` already documents
as its two-tier fallback (buffer, then Sheets) — the tiers just change from
(in-memory, Sheets) to (Turso `readings`, Sheets).

## Calibration UX change: captures are immediately live

Per the approved decision, `/calibration/capture` writes its recomputed coefficients straight
to `station_state.calibration_json` and takes effect immediately — no more "uncommitted in
memory until Save" gate (nothing could hold that state between serverless invocations anyway).
`/calibration/save`'s remaining job shrinks to stamping each sensor's `updated` ISO-timestamp
(the one thing captures don't already do) — the endpoint stays, its behavior just narrows,
so the frontend's existing Save button still does something meaningful without needing to be
rebuilt in this sub-project (frontend changes are sub-project #6's scope).

## Daily usage: drop the in-memory cache entirely

`_daily_usage_totals`/`_daily_usage_seeded` are explicitly documented today as "kept in-memory
as the hot-path value... so the quick-view doesn't need a DB round-trip on every 2s reading"
(`main.py:272-276`) — a cache over `storage.py`'s already-Turso-backed `daily_usage` table
(sub-project #2). Once every invocation hits Turso directly regardless (the new normal for
everything else in this sub-project), this cache stops being useful and is removed outright.
`storage.add_daily_usage()` changes from fire-and-forget (`asyncio.create_task`, returns
nothing) to awaited and returning the new total, so `/update`'s response payload
(`waterUsageToday`) can still be populated synchronously without the removed cache.

## What touches `main.py`

Every function currently reading/writing `PER_STATION_MAPS` needs rework: `/update` ingestion
(the biggest change — every reading now INSERTs into `readings` and upserts `station_state`
instead of touching 9 dicts), `/history`, `GET /calibration` + all `/calibration/*` POSTs,
`/flow/usage` (only the in-memory-cache half — the Turso-backed half from sub-project #2 is
unaffected), `POST /station/rename` (its migration logic changes from "move dict entries" to
"UPDATE readings/station_state SET station = ? WHERE station = ?"), `GET /ai-report` +
`POST /ai-report/generate`, and the `/ws/app` WebSocket's prime-frame logic.

`PER_STATION_MAPS` itself (and `_station_known_in_memory`) is retired — station existence
becomes a Turso query (`SELECT 1 FROM station_state WHERE station = ?` or `readings`), same
spirit as `station_has_usage` already established in `storage.py`.

## Non-goals

- The WebSocket transport itself (`/ws/app`'s connection mechanism) — unaffected structurally
  by this sub-project (it still broadcasts to `ui_clients`); replacing it with a
  Vercel-Python-compatible mechanism is sub-project #4.
- Restructuring `main.py` into Vercel's function-per-file conventions — sub-project #5.
- Frontend changes (e.g., the calibration tab's Save-button UX now being narrower) —
  sub-project #6, though this spec's calibration-UX change should be flagged to whoever
  brainstorms #6.
- `google_apps_script.gs` / the Sheets relay itself — untouched, still the long-term archive.

## Testing

No automated test suite exists. Verification is manual, same pattern as sub-project #2:
exercise the rewritten endpoints against a real Turso database (credentials permitting) and
confirm behavior matches today's — a station's `/update` → `/history` → `/calibration` →
`/station/rename` round-trip, breach-edge-detection firing only on transitions, and the daily
AI-report rollup producing the same shape of stats it does today.
