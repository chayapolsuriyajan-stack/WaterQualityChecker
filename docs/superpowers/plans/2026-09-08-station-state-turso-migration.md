# Migrate per-station in-memory state to Turso Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every per-station in-memory structure in `main.py` (`PER_STATION_MAPS`'s 9
dicts, `_daily_usage_seeded`, and the `calibration.json` file) with Turso-backed state, so the
backend holds nothing that a serverless invocation boundary would wipe.

**Architecture:** Two new Turso tables. `readings` (one row per `/update`, station+timestamp
indexed, 24h-pruned) replaces every structure that was really just a derived view over recent
reading history (`history_buffer`, `sensor_stats`, `latest_raw`/`_raw_buffers`, `_daily_stats`/
`_daily_breach_counts`) — those become `SELECT`/`MIN`/`MAX`/`ORDER BY ... LIMIT` queries.
`station_state` (one row per station: calibration JSON, calibration-mode flag, breach
edge-detection JSON) replaces the genuinely-stateful structures and retires
`calibration.json` entirely. `_daily_usage_totals`/`_daily_usage_seeded` are deleted outright as
a now-redundant cache over the already-Turso-backed `daily_usage` table (sub-project #2).

**Tech Stack:** FastAPI (`main.py`), `libsql` (Turso), the existing `storage.py` connection
layer and `_Row`/`_CursorWrapper`/`_ConnWrapper` adapter from sub-project #2.

## Global Constraints

- No automated test suite exists in this repo (Python or firmware side) — every verification
  step below is a standalone script run manually, same pattern as sub-project #2's
  cross-thread verification.
- Every `storage.py` function follows the existing degrade-not-crash contract: `_conn is None`
  (Turso disabled/unreachable) returns a safe default (`None`/`[]`/`0.0`/`False`) and never
  raises; wrap every DB call in `try/except Exception` and `print(f"⚠️ ...: {exc}")`, matching
  every function already in the file.
- Every `main.py` DB call goes through `asyncio.to_thread(storage.xxx, ...)` — `libsql`'s
  connection is synchronous, and this is how the event loop stays unblocked (established in
  sub-project #2, `_check_same_thread=False` already set in `storage.init`).
- Every new/changed function keeps the same commenting density and style already in the file
  (a docstring or leading comment explaining *why*, not just *what*) — match the surrounding
  code, don't strip it down.
- Real Turso credentials do not exist in this environment yet. Verification scripts must work
  against a local file-backed `libsql.connect(database="file:...")` connection (no network) so
  they run without live credentials — same substitute sub-project #2 used.

---

### Task 1: `storage.py` — `readings` and `station_state` tables + query functions

**Files:**
- Modify: `storage.py`

**Interfaces:**
- Produces (used by Tasks 2-4):
  - `insert_reading(station: str, ts_ms: int, fields: dict) -> None`
  - `prune_readings(older_than_ms: int) -> None`
  - `get_readings(station: str, since_ms: float) -> list[dict]` — each dict:
    `{"timestamp": int, "temperature": float|None, "turbidity": float|None,
    "turbidityNtu": float|None, "tds": float|None, "tdsVoltage": float|None, "ec": float|None,
    "flowPulses": float|None, "flowRate": float|None}`
  - `get_latest_reading(station: str) -> dict | None` — same shape as one `get_readings` row
  - `get_recent_raw(station: str, column: str, limit: int = 5) -> list[float]` — `column` one
    of `"turbidity_raw"`, `"tds_voltage"`, `"flow_pulses"`
  - `get_reading_extremes(station: str, since_ms: float, columns: tuple[str, ...]) -> dict[str, dict]`
    — `{column: {"min": float, "max": float, "avg": float, "count": int}}`, only for columns
    with at least one non-null value in range
  - `get_reading_values(station: str, since_ms: float, column: str) -> list[float]`
  - `list_stations() -> list[str]`
  - `get_station_state(station: str) -> dict | None` — `{"calibration": dict,
    "calibrationMode": bool, "lastSeverity": dict}` or `None` if the station has no row yet
  - `upsert_station_state(station: str, calibration: dict, calibration_mode: bool, last_severity: dict) -> None`
  - `station_exists(station: str) -> bool`
  - `rename_readings(old: str, new: str) -> None`
  - `rename_station_state(old: str, new: str) -> None`
  - `add_daily_usage(date: str, station: str, liters: float) -> float` — **signature change**:
    now returns the new running total instead of `None` (was fire-and-forget before)

- [ ] **Step 1: Add the two new tables to `_SCHEMA`**

In `storage.py`, extend the `_SCHEMA` string (after the existing `ai_reports` table):

```python
_SCHEMA = """
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    prefs_json  TEXT NOT NULL,
    created_ms  INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_usage (
    date         TEXT NOT NULL,
    station      TEXT NOT NULL DEFAULT 'default',
    total_liters REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (date, station)
);

CREATE TABLE IF NOT EXISTS ai_reports (
    date         TEXT NOT NULL,
    station      TEXT NOT NULL DEFAULT 'default',
    report_text  TEXT NOT NULL,
    created_ms   INTEGER NOT NULL,
    PRIMARY KEY (date, station)
);

-- One row per sensor reading (replaces main.py's old in-memory history_buffer/sensor_stats/
-- latest_raw/_raw_buffers/_daily_stats/_daily_breach_counts -- see
-- docs/superpowers/specs/2026-09-08-station-state-turso-migration-design.md). Pruned to the
-- last 24h by main.py (prune_readings below); Google Sheets remains the durable long-term
-- archive for anything older, same two-tier split /history already documented.
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

-- One row per station: calibration coefficients + mode, and breach edge-detection state.
-- Replaces main.py's old in-memory calibration/calibration_mode dicts and calibration.json
-- (retired entirely) plus last_severity.
CREATE TABLE IF NOT EXISTS station_state (
    station             TEXT PRIMARY KEY,
    calibration_json    TEXT NOT NULL,
    calibration_mode    INTEGER NOT NULL DEFAULT 0,
    last_severity_json  TEXT NOT NULL DEFAULT '{}'
);
"""
```

- [ ] **Step 2: Add the reading-column constant and row-shaping helper**

Add near the top of `storage.py`, after the `_ConnWrapper` class:

```python
# Column names in `readings` that hold an actual sensor value (excludes id/station/ts_ms,
# which every reading function already handles explicitly).
_READING_COLUMNS = (
    "temperature", "turbidity_raw", "turbidity_ntu", "tds_voltage",
    "tds_ppm", "ec", "flow_pulses", "flow_rate",
)


def _reading_row_to_dict(r) -> dict:
    """Maps one `readings` row onto the shape main.py's old history_buffer rows had, so
    every consumer (the /history endpoint, the WS prime frame) needed no reshaping."""
    return {
        "timestamp": r["ts_ms"],
        "temperature": r["temperature"],
        "turbidity": r["turbidity_raw"],
        "turbidityNtu": r["turbidity_ntu"],
        "tds": r["tds_ppm"],
        "tdsVoltage": r["tds_voltage"],
        "ec": r["ec"],
        "flowPulses": r["flow_pulses"],
        "flowRate": r["flow_rate"],
    }
```

- [ ] **Step 3: Add `insert_reading` and `prune_readings`**

```python
def insert_reading(station: str, ts_ms: int, fields: dict) -> None:
    """Inserts one reading row. `fields` may omit any of _READING_COLUMNS (missing -> NULL,
    e.g. a legacy water_level-only POST that never calls this at all, or a POST with no
    flow sensor attached)."""
    if _conn is None:
        return
    cols = ["station", "ts_ms"] + list(_READING_COLUMNS)
    values = [station, ts_ms] + [fields.get(c) for c in _READING_COLUMNS]
    placeholders = ", ".join("?" for _ in cols)
    try:
        with _lock:
            _conn.execute(
                f"INSERT INTO readings ({', '.join(cols)}) VALUES ({placeholders})",
                tuple(values),
            )
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Reading insert failed: {exc}")


def prune_readings(older_than_ms: int) -> None:
    """Deletes every reading older than `older_than_ms` across all stations -- called
    opportunistically (not on every write) by main.py to keep the table's growth bounded
    without a separate scheduler."""
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute("DELETE FROM readings WHERE ts_ms < ?", (older_than_ms,))
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Reading prune failed: {exc}")
```

- [ ] **Step 4: Add the reading-query functions**

```python
_READING_SELECT = (
    "ts_ms, temperature, turbidity_raw, turbidity_ntu, tds_voltage, tds_ppm, ec,"
    " flow_pulses, flow_rate"
)


def get_readings(station: str, since_ms: float) -> list[dict]:
    """`station`'s rows at/after `since_ms`, chronological ascending -- the live-window
    source for GET /history (was history_buffer)."""
    if _conn is None:
        return []
    try:
        with _lock:
            rows = _conn.execute(
                f"SELECT {_READING_SELECT} FROM readings"
                " WHERE station = ? AND ts_ms >= ? ORDER BY ts_ms ASC",
                (station, since_ms),
            ).fetchall()
    except Exception as exc:
        print(f"⚠️ Reading read failed: {exc}")
        return []
    return [_reading_row_to_dict(r) for r in rows]


def get_latest_reading(station: str) -> dict | None:
    """`station`'s single most recent reading, or None if it has never reported -- used by
    the WS connect-time prime frame and calibration-capture's temperature/latestRaw fields."""
    if _conn is None:
        return None
    try:
        with _lock:
            row = _conn.execute(
                f"SELECT {_READING_SELECT} FROM readings"
                " WHERE station = ? ORDER BY ts_ms DESC LIMIT 1",
                (station,),
            ).fetchone()
    except Exception as exc:
        print(f"⚠️ Reading read failed: {exc}")
        return None
    return _reading_row_to_dict(row) if row else None


def get_recent_raw(station: str, column: str, limit: int = 5) -> list[float]:
    """Last `limit` non-null values of one raw column, most-recent-first -- averaged by
    main.py's calibration-capture endpoint to smooth out electrical noise (was
    latest_raw/_raw_buffers). `column` must be one of _READING_COLUMNS."""
    if _conn is None or column not in _READING_COLUMNS:
        return []
    try:
        with _lock:
            rows = _conn.execute(
                f"SELECT {column} FROM readings WHERE station = ? AND {column} IS NOT NULL"
                " ORDER BY ts_ms DESC LIMIT ?",
                (station, limit),
            ).fetchall()
    except Exception as exc:
        print(f"⚠️ Reading read failed: {exc}")
        return []
    return [r[column] for r in rows]


def get_reading_extremes(station: str, since_ms: float, columns: tuple[str, ...]) -> dict[str, dict]:
    """{column: {"min", "max", "avg", "count"}} across every column in `columns` for rows at/
    after `since_ms`, one query -- replaces sensor_stats (since_ms=0, meaning "since the
    oldest retained row") and the AI report's daily rollup (since_ms=local midnight). A
    column with zero non-null rows in range is omitted from the result entirely."""
    if _conn is None:
        return {}
    bad = [c for c in columns if c not in _READING_COLUMNS]
    if bad:
        raise ValueError(f"unknown reading column(s): {bad}")
    if not columns:
        return {}
    select = ", ".join(
        f"MIN({c}) AS {c}_min, MAX({c}) AS {c}_max, AVG({c}) AS {c}_avg, COUNT({c}) AS {c}_count"
        for c in columns
    )
    try:
        with _lock:
            row = _conn.execute(
                f"SELECT {select} FROM readings WHERE station = ? AND ts_ms >= ?",
                (station, since_ms),
            ).fetchone()
    except Exception as exc:
        print(f"⚠️ Reading stats read failed: {exc}")
        return {}
    if row is None:
        return {}
    out = {}
    for c in columns:
        count = row[f"{c}_count"]
        if not count:
            continue
        out[c] = {"min": row[f"{c}_min"], "max": row[f"{c}_max"], "avg": row[f"{c}_avg"], "count": count}
    return out


def get_reading_values(station: str, since_ms: float, column: str) -> list[float]:
    """Every non-null value of one column at/after since_ms -- used for breach-counting in
    Python (thresholds.range_status_for isn't expressible in SQL), only at AI-report
    generation time (once/day, or on manual "Generate now"), never on the /update hot path."""
    if _conn is None or column not in _READING_COLUMNS:
        return []
    try:
        with _lock:
            rows = _conn.execute(
                f"SELECT {column} FROM readings"
                f" WHERE station = ? AND ts_ms >= ? AND {column} IS NOT NULL",
                (station, since_ms),
            ).fetchall()
    except Exception as exc:
        print(f"⚠️ Reading read failed: {exc}")
        return []
    return [r[column] for r in rows]


def list_stations() -> list[str]:
    """Every station with at least one reading, station_state row, or daily_usage row --
    used wherever main.py used to iterate its in-memory PER_STATION_MAPS' keys (the WS
    connect-time prime frame, the midnight AI-report scheduler)."""
    if _conn is None:
        return []
    try:
        with _lock:
            rows = _conn.execute(
                "SELECT station FROM readings"
                " UNION SELECT station FROM station_state"
                " UNION SELECT station FROM daily_usage"
            ).fetchall()
    except Exception as exc:
        print(f"⚠️ Station list read failed: {exc}")
        return []
    return [r["station"] for r in rows]
```

- [ ] **Step 5: Add `station_state` functions**

```python
def get_station_state(station: str) -> dict | None:
    """`station`'s calibration + mode + breach-edge-detection state, or None if it has never
    had any (a brand-new station) -- caller (main.py) supplies its own defaults in that case."""
    if _conn is None:
        return None
    try:
        with _lock:
            row = _conn.execute(
                "SELECT calibration_json, calibration_mode, last_severity_json"
                " FROM station_state WHERE station = ?",
                (station,),
            ).fetchone()
    except Exception as exc:
        print(f"⚠️ Station state read failed: {exc}")
        return None
    if row is None:
        return None
    return {
        "calibration": json.loads(row["calibration_json"]),
        "calibrationMode": bool(row["calibration_mode"]),
        "lastSeverity": json.loads(row["last_severity_json"]),
    }


def upsert_station_state(station: str, calibration: dict, calibration_mode: bool, last_severity: dict) -> None:
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute(
                "INSERT INTO station_state (station, calibration_json, calibration_mode, last_severity_json)"
                " VALUES (?, ?, ?, ?)"
                " ON CONFLICT(station) DO UPDATE SET calibration_json=excluded.calibration_json,"
                " calibration_mode=excluded.calibration_mode, last_severity_json=excluded.last_severity_json",
                (station, json.dumps(calibration), int(calibration_mode), json.dumps(last_severity)),
            )
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Station state write failed: {exc}")


def station_exists(station: str) -> bool:
    """True if `station` has a station_state row, any reading, or any daily_usage row --
    used by /station/rename's collision checks now that nothing lives in memory."""
    if _conn is None:
        return False
    try:
        with _lock:
            row = _conn.execute(
                "SELECT 1 FROM station_state WHERE station = ?"
                " UNION SELECT 1 FROM readings WHERE station = ?"
                " UNION SELECT 1 FROM daily_usage WHERE station = ? LIMIT 1",
                (station, station, station),
            ).fetchone()
    except Exception as exc:
        print(f"⚠️ Station existence check failed: {exc}")
        return False
    return row is not None


def rename_readings(old: str, new: str) -> None:
    """Moves every readings row from `old` to `new`. Caller must have already confirmed
    `new` has no existing rows anywhere (station_exists) -- same precondition as
    rename_station_usage."""
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute("UPDATE readings SET station = ? WHERE station = ?", (new, old))
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Reading rename failed: {exc}")


def rename_station_state(old: str, new: str) -> None:
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute("UPDATE station_state SET station = ? WHERE station = ?", (new, old))
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Station state rename failed: {exc}")
```

- [ ] **Step 6: Change `add_daily_usage` to return the new total**

Replace the existing `add_daily_usage` function body (it currently returns `None`):

```python
def add_daily_usage(date: str, station: str, liters: float) -> float:
    """Adds `liters` to `station`'s running total for `date` (creating the row if this is
    its first reading of the day) and returns the new total. Returns 0.0 if disabled or the
    write failed -- there is no in-memory cache left to fall back to (removed in the
    per-station-state Turso migration), so a failed write here means main.py's
    waterUsageToday for this reading is genuinely unknown, not just stale."""
    if _conn is None or liters is None:
        return 0.0
    try:
        with _lock:
            _conn.execute(
                "INSERT INTO daily_usage (date, station, total_liters) VALUES (?, ?, ?)"
                " ON CONFLICT(date, station) DO UPDATE SET total_liters = total_liters + excluded.total_liters",
                (date, station, liters),
            )
            row = _conn.execute(
                "SELECT total_liters FROM daily_usage WHERE date = ? AND station = ?",
                (date, station),
            ).fetchone()
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Daily usage write failed: {exc}")
        return 0.0
    return row["total_liters"] if row else 0.0
```

- [ ] **Step 7: Update the module docstring**

The file's top docstring currently says reading history "is NOT stored here". Replace the
docstring (lines 1-14) to reflect that readings now do live here:

```python
"""Turso (libSQL) persistence for sensor readings, per-station state, push subscriptions,
and daily water usage.

Design notes:
- One module-level connection with `check_same_thread=False`, guarded by a lock. Every
  public function here is blocking, and `main.py` calls them via `asyncio.to_thread` so a
  slow network round-trip never stalls the event loop or the ESP32's `/update` response.
- The `readings` table is pruned to the last 24h by main.py (see prune_readings) --
  Google Sheets remains the durable long-term archive for anything older.
"""
```

- [ ] **Step 8: Verify with a standalone script**

Write `C:\Users\Ace\AppData\Local\Temp\claude\C--Users-Ace-Documents-projects-WaterQualityChecker\ca54fd94-a186-4871-8f3f-9b97abb02fc8\scratchpad\verify_storage_task1.py`:

```python
import sys
sys.path.insert(0, r"C:\Users\Ace\Documents\projects\WaterQualityChecker")
import time
import storage

assert storage.init("file:/tmp/verify_task1.db", ""), "init failed"

now_ms = int(time.time() * 1000)
storage.insert_reading("Inlet", now_ms - 5000, {"temperature": 20.0, "turbidity_raw": 100})
storage.insert_reading("Inlet", now_ms, {"temperature": 22.0, "turbidity_raw": 150, "flow_rate": 3.0})

rows = storage.get_readings("Inlet", now_ms - 10000)
assert len(rows) == 2, rows
assert rows[0]["temperature"] == 20.0 and rows[1]["temperature"] == 22.0, rows

latest = storage.get_latest_reading("Inlet")
assert latest["temperature"] == 22.0, latest

extremes = storage.get_reading_extremes("Inlet", 0, ("temperature", "flow_rate"))
assert extremes["temperature"]["min"] == 20.0 and extremes["temperature"]["max"] == 22.0, extremes
assert extremes["flow_rate"]["count"] == 1, extremes

recent = storage.get_recent_raw("Inlet", "turbidity_raw", 5)
assert recent == [150, 100], recent

storage.prune_readings(now_ms + 1)
assert storage.get_readings("Inlet", 0) == [], "prune did not remove rows"

storage.upsert_station_state("Inlet", {"turbidity": {}}, True, {"temperature": "warn"})
state = storage.get_station_state("Inlet")
assert state == {"calibration": {"turbidity": {}}, "calibrationMode": True, "lastSeverity": {"temperature": "warn"}}, state
assert storage.get_station_state("NoSuchStation") is None

assert storage.station_exists("Inlet") is True
assert storage.station_exists("NoSuchStation") is False

storage.insert_reading("Inlet", now_ms, {"temperature": 22.0})
storage.rename_readings("Inlet", "Inlet2")
storage.rename_station_state("Inlet", "Inlet2")
assert storage.station_exists("Inlet2") is True
assert storage.get_station_state("Inlet") is None

assert set(storage.list_stations()) == {"Inlet2"}, storage.list_stations()

total1 = storage.add_daily_usage("2026-09-08", "Inlet2", 5.0)
assert total1 == 5.0, total1
total2 = storage.add_daily_usage("2026-09-08", "Inlet2", 2.5)
assert total2 == 7.5, total2

print("Task 1 storage.py verification: ALL PASSED")
```

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe C:\Users\Ace\AppData\Local\Temp\claude\C--Users-Ace-Documents-projects-WaterQualityChecker\ca54fd94-a186-4871-8f3f-9b97abb02fc8\scratchpad\verify_storage_task1.py`

Expected output: `Task 1 storage.py verification: ALL PASSED`

- [ ] **Step 9: Commit**

```bash
git add storage.py
git commit -m "storage.py: add readings + station_state tables for per-station Turso migration"
```

---

### Task 2: `main.py` — pure calibration/flow functions + `_load_station_state`/`_save_station_state` helpers, retire `calibration.json`

**Files:**
- Modify: `main.py`

**Interfaces:**
- Consumes: `storage.get_station_state`, `storage.upsert_station_state` (Task 1)
- Produces (used by Tasks 3-4):
  - `apply_turbidity(calib: dict, adc: float) -> float | None` (was `apply_turbidity(station, adc)`)
  - `apply_tds(calib: dict, voltage: float, temperature_c) -> float` (was `apply_tds(station, voltage, temperature_c)`)
  - `apply_flow(calib: dict, mode: bool, pulses: float) -> tuple[float, float]` (was `apply_flow(station, pulses)`)
  - `_recompute_turbidity(calib: dict) -> None`, `_recompute_tds(calib: dict) -> None`,
    `_recompute_flow(calib: dict) -> None` (all now take a calib dict, not a station name)
  - `_check_breaches_and_dispatch(station_severity: dict, payload: dict) -> list` (was
    `_check_breaches_and_dispatch(station, payload)` reading the global `last_severity`) --
    mutates `station_severity` in place
  - `async def _load_station_state(station: str) -> tuple[dict, bool, dict]` — returns
    `(calibration, calibration_mode, last_severity)`, defaults (`_default_calibration()`,
    `False`, `{}`) if Turso has no row yet
  - `async def _save_station_state(station: str, calib: dict, mode: bool, last_severity: dict) -> None`

- [ ] **Step 1: Refactor `apply_turbidity`/`apply_tds`/`apply_flow` to take an explicit `calib` dict**

Replace:

```python
def apply_turbidity(station: str, adc: float):
    coeffs = _station_calibration(station)["turbidity"]["coefficients"]
    if not coeffs:
        return None
    ntu = coeffs["slope"] * adc + coeffs["intercept"]
    return round(max(0.0, ntu), 1)


def apply_tds(station: str, voltage: float, temperature_c) -> float:
    k = (_station_calibration(station)["tds"]["coefficients"] or {}).get("k", 1.0)
    return round(k * _dfrobot_ppm(voltage, temperature_c), 1)
```

with:

```python
def apply_turbidity(calib: dict, adc: float):
    coeffs = calib["turbidity"]["coefficients"]
    if not coeffs:
        return None
    ntu = coeffs["slope"] * adc + coeffs["intercept"]
    return round(max(0.0, ntu), 1)


def apply_tds(calib: dict, voltage: float, temperature_c) -> float:
    k = (calib["tds"]["coefficients"] or {}).get("k", 1.0)
    return round(k * _dfrobot_ppm(voltage, temperature_c), 1)
```

Replace:

```python
def apply_flow(station: str, pulses: float) -> tuple[float, float]:
    """Returns (litersThisInterval, flowRateLpm) from a raw pulse count. Only applies the
    saved k-factor when calibration mode is ON (mirrors apply_tds); OFF uses the nominal
    YF-S201 default so an unconfigured/miscalibrated k can't silently skew the live reading."""
    mode = _station_calibration_mode(station)
    k = (_station_calibration(station)["flow"]["coefficients"] or {}).get("k", 450.0) if mode else 450.0
    if not k:
        return 0.0, 0.0
    liters = pulses / k
    rate_lpm = liters * (60.0 / FLOW_INTERVAL_SECONDS)
    return round(liters, 4), round(rate_lpm, 2)
```

with:

```python
def apply_flow(calib: dict, mode: bool, pulses: float) -> tuple[float, float]:
    """Returns (litersThisInterval, flowRateLpm) from a raw pulse count. Only applies the
    saved k-factor when calibration mode is ON (mirrors apply_tds); OFF uses the nominal
    YF-S201 default so an unconfigured/miscalibrated k can't silently skew the live reading."""
    k = (calib["flow"]["coefficients"] or {}).get("k", 450.0) if mode else 450.0
    if not k:
        return 0.0, 0.0
    liters = pulses / k
    rate_lpm = liters * (60.0 / FLOW_INTERVAL_SECONDS)
    return round(liters, 4), round(rate_lpm, 2)
```

- [ ] **Step 2: Refactor `_recompute_turbidity`/`_recompute_tds`/`_recompute_flow` to take an explicit `calib` dict**

Replace:

```python
def _recompute_turbidity(station: str) -> None:
    # 2-point linear fit. With >2 points, use the first and last by raw ADC so the line
    # spans the full captured range; a single point can't define a slope.
    calib = _station_calibration(station)
    points = calib["turbidity"]["points"]
```

with:

```python
def _recompute_turbidity(calib: dict) -> None:
    # 2-point linear fit. With >2 points, use the first and last by raw ADC so the line
    # spans the full captured range; a single point can't define a slope.
    points = calib["turbidity"]["points"]
```

(leave the rest of the function body unchanged). Apply the same pattern to `_recompute_tds`
and `_recompute_flow` — drop the `calib = _station_calibration(station)` line, change the
`def` signature's parameter from `station: str` to `calib: dict`, keep everything else as-is.

- [ ] **Step 3: Refactor `_check_breaches_and_dispatch` to take the severity dict directly**

Replace:

```python
def _check_breaches_and_dispatch(station: str, payload: dict) -> list:
    breaches = []
    station_severity = last_severity.setdefault(station, {})
    for param in PUSH_PARAMS:
```

with:

```python
def _check_breaches_and_dispatch(station_severity: dict, payload: dict) -> list:
    """Mutates `station_severity` in place (edge-detection state for one station), returns
    the list of (param, severity) pairs that just crossed into warn/danger this reading."""
    breaches = []
    for param in PUSH_PARAMS:
```

(the loop body below already reads/writes `station_severity` — no further change needed there).

- [ ] **Step 4: Add `_load_station_state`/`_save_station_state`, remove the calibration.json/global-dict machinery**

Delete these functions/globals entirely (they're being replaced): `_load_calibration`,
`_save_calibration`, `calibration`, `calibration_mode`, `_station_calibration`,
`_station_calibration_mode`, `CALIBRATION_PATH` (also remove its `webconfig.get(...)` line
near the top of the file and its now-dead `"calibrationFile"` webconfig key — see Step 5),
`latest_raw`, `_raw_buffers`, `_station_latest_raw`, `_station_raw_buffers`, `last_severity`.

Keep `CALIBRATED_SENSORS` and `_default_calibration` — both still needed. Delete
`_initial_calibration_mode` too: it existed only to infer an ON/OFF default for
`calibration_mode` from a loaded `calibration.json`'s contents, and `_load_station_state`
below has no equivalent inference to make — a station with no `station_state` row is simply
brand-new (defaults to `False`, matching a fresh `_default_calibration()`), and one that has
a row already has `calibrationMode` stored explicitly.

Add, in roughly the same place `_station_calibration`/`_station_calibration_mode` used to
live:

```python
async def _load_station_state(station: str) -> tuple[dict, bool, dict]:
    """Returns (calibration, calibration_mode, last_severity) for `station` from Turso,
    or fresh defaults if it has never had a station_state row (a brand-new station, or Turso
    disabled). Every /update and every /calibration* endpoint calls this once per request --
    there is no in-memory cache any more (see the per-station-state Turso migration spec)."""
    state = await asyncio.to_thread(storage.get_station_state, station) if storage.enabled() else None
    if state is None:
        return _default_calibration(), False, {}
    return state["calibration"], state["calibrationMode"], state["lastSeverity"]


async def _save_station_state(station: str, calib: dict, mode: bool, last_severity: dict) -> None:
    if storage.enabled():
        await asyncio.to_thread(storage.upsert_station_state, station, calib, mode, last_severity)
```

- [ ] **Step 5: Remove the now-dead `calibrationFile` config and its webconfig.json key**

Delete this line near the top of `main.py`:

```python
CALIBRATION_PATH = webconfig.get("calibrationFile", "calibration.json")
```

In `webconfig.json`, delete the `"calibrationFile"` key if present.

- [ ] **Step 6: Static-compile-check the file**

`main.py` still references the now-deleted globals/functions elsewhere (the `/update` route,
`/calibration*` routes, `/history`, `/station/rename`, `/ws/app`, `PER_STATION_MAPS`) — those
are rewritten in Tasks 3-4, not this one. Confirm this task's own edits are syntactically
valid without needing the whole file to import cleanly yet:

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import ast; ast.parse(open('main.py', encoding='utf-8').read())"`

Expected: no output (successful parse — `ast.parse` only checks syntax, not that every name
resolves, which is exactly what's needed here since Tasks 3-4 haven't run yet).

- [ ] **Step 7: Commit**

```bash
git add main.py webconfig.json
git commit -m "main.py: pure calibration/flow functions + Turso-backed station state helpers"
```

---

### Task 3: `main.py` — rewrite `POST /update` against Turso, remove the retired in-memory globals

**Files:**
- Modify: `main.py`

**Interfaces:**
- Consumes: Task 1's `storage.insert_reading`/`storage.prune_readings`/
  `storage.get_reading_extremes`/`storage.add_daily_usage`; Task 2's `apply_turbidity`/
  `apply_tds`/`apply_flow`/`_check_breaches_and_dispatch`/`_load_station_state`/
  `_save_station_state`
- Produces (used by Task 4): the rewritten `POST /update` route as the reference shape for
  Task 4's own storage-backed rewrites of `/history`/`/calibration*`/`/ws/app`

- [ ] **Step 1: Remove the retired in-memory globals and their helpers**

Delete: `STAT_KEYS`, `sensor_stats`, `HISTORY_BUFFER_MAX`, `history_buffer`,
`_station_history`, `_daily_usage_date`, `_daily_usage_totals`, `_daily_usage_seeded`,
`_add_daily_usage`, `_update_stats`, `_stats_snapshot`, `_daily_stats_date`, `_daily_stats`,
`_daily_breach_counts`, `_update_daily_stats`, `PER_STATION_MAPS`, `_station_known_in_memory`.

Keep `_local_date` — still used (daily usage's date key, AI-report cooldown/date logic in
Task 4).

- [ ] **Step 2: Add `import random` and the retention-prune trigger**

Add `import random` to the top-of-file import block (alongside the existing `import time`,
`import datetime`, etc.).

- [ ] **Step 3: Rewrite `POST /update`**

Replace the entire `update_sensor` function body with:

```python
@app.post("/update")
async def update_sensor(request: Request):
    # Checked only when UPDATE_API_KEY is configured (see its definition above) -- keeps every
    # same-LAN-only setup working unauthenticated exactly as before. constant_time comparison
    # since this is a secret comparison over a network-reachable endpoint.
    if not _check_update_api_key(request):
        return JSONResponse({"error": "invalid or missing X-API-Key"}, status_code=401)
    try:
        data = await request.json()
        # See DEFAULT_STATION above: a board that never had a name provisioned (old
        # firmware, or a fresh unprovisioned board) omits `station` entirely, and normalizes
        # to the same single implicit station every prior version of this app had.
        station = _normalize_station(data.get("station"))
        payload = {
            "source": "arduino",
            "timestamp": int(time.time()),
            "station": station,
        }

        calib, station_mode, station_severity = await _load_station_state(station)
        breaches: list = []

        if "temperature" in data and "turbidity" in data:
            payload["temperature"] = float(data["temperature"])
            # Turbidity arrives as the averaged raw ADC and is kept in `turbidity` (both
            # dashboards read that key). The calibrated NTU rides along in `turbidityNtu`
            # when a turbidity calibration is active (else None).
            turbidity_adc = float(data["turbidity"])
            # Only apply this station's saved calibration when calibration mode is ON (the
            # Calibration tab's on/off button). OFF => ntu stays None => dashboard shows raw ADC.
            ntu = apply_turbidity(calib, turbidity_adc) if station_mode else None
            # `turbidityRaw` always carries the raw averaged ADC (for the calibration page +
            # honest Google Sheets logging). The primary `turbidity` field carries calibrated
            # NTU once a calibration exists, else falls back to raw ADC -- the React SPA (a
            # prebuilt bundle we can't edit) reads `turbidity` and labels it NTU, so this makes
            # it show real NTU. `turbidityUnit` tells the editable dashboards which unit it is.
            payload["turbidityRaw"] = turbidity_adc
            payload["turbidityNtu"] = ntu
            if ntu is not None:
                payload["turbidity"] = ntu
                payload["turbidityUnit"] = "NTU"
            else:
                payload["turbidity"] = turbidity_adc
                payload["turbidityUnit"] = "ADC"

            # TDS: prefer the raw voltage from current firmware (backend computes ppm via
            # calibration). Fall back to a legacy pre-computed `tds` ppm from an un-reflashed
            # board so the old firmware keeps working (backward-compatible contract).
            if "tdsVoltage" in data:
                tds_voltage = float(data["tdsVoltage"])
                payload["tdsVoltage"] = tds_voltage
                # Apply the k-factor only when calibration mode is ON; OFF => uncalibrated
                # DFRobot ppm (k = 1.0).
                payload["tds"] = (
                    apply_tds(calib, tds_voltage, payload["temperature"])
                    if station_mode
                    else round(_dfrobot_ppm(tds_voltage, payload["temperature"]), 1)
                )
            elif "tds" in data:
                payload["tds"] = float(data["tds"])

            # EC is derived from the same measurement as TDS (see ppm_to_ec) -- emitted as
            # its own field so dashboards don't each re-derive the conversion factor.
            ec = ppm_to_ec(payload.get("tds"))
            if ec is not None:
                payload["ec"] = ec

            # Flow sensor: firmware sends the raw pulse count accumulated over the last
            # FLOW_INTERVAL_SECONDS (a hall-effect pulse counter, unlike the other analog
            # sensors). No thresholds/calibration-mode-off fallback beyond apply_flow's own
            # gating -- flow rate/usage are plain quantities, not water-quality judgments.
            if "flowPulses" in data:
                flow_pulses = float(data["flowPulses"])
                liters, flow_rate = apply_flow(calib, station_mode, flow_pulses)
                payload["flowRate"] = flow_rate
                if storage.enabled():
                    total = await asyncio.to_thread(storage.add_daily_usage, _local_date(), station, liters)
                else:
                    # No Turso, no in-memory cache any more -- this interval's own liters is
                    # the best available answer, not a running daily total.
                    total = liters
                payload["waterUsageToday"] = round(total, 4)

            if storage.enabled():
                ts_ms = payload["timestamp"] * 1000
                await asyncio.to_thread(
                    storage.insert_reading,
                    station,
                    ts_ms,
                    {
                        "temperature": payload.get("temperature"),
                        "turbidity_raw": payload.get("turbidityRaw"),
                        "turbidity_ntu": payload.get("turbidityNtu"),
                        "tds_voltage": payload.get("tdsVoltage"),
                        "tds_ppm": payload.get("tds"),
                        "ec": payload.get("ec"),
                        "flow_pulses": data.get("flowPulses"),
                        "flow_rate": payload.get("flowRate"),
                    },
                )
                # Opportunistic retention prune (not on every write -- a DELETE scan on every
                # 2s reading would be wasteful). ~1/100 writes is frequent enough that the
                # table never grows far past 24h + a few minutes of readings.
                if random.random() < 0.01:
                    cutoff_ms = int((time.time() - 86400) * 1000)
                    asyncio.create_task(asyncio.to_thread(storage.prune_readings, cutoff_ms))

                # Running min/max since the oldest retained reading (redefined from "since
                # server start" now that there's no persistent server -- see the migration
                # spec's Retention section). turbidity's column choice matches whichever unit
                # this station is currently displaying, same as the old in-memory sensor_stats
                # did (a station that toggles calibration mode mid-window will see the same
                # unit-mixing quirk the original had).
                stat_columns = {
                    "temperature": "temperature",
                    "turbidity": "turbidity_ntu" if station_mode else "turbidity_raw",
                    "tds": "tds_ppm",
                    "flowRate": "flow_rate",
                }
                extremes = await asyncio.to_thread(
                    storage.get_reading_extremes, station, 0, tuple(set(stat_columns.values()))
                )
                payload["stats"] = {
                    key: {"min": extremes[col]["min"], "max": extremes[col]["max"]}
                    for key, col in stat_columns.items()
                    if col in extremes
                }
            else:
                payload["stats"] = {}

            # Threshold-breach push notifications: detection is synchronous/inline (must
            # observe every reading in order to edge-detect correctly); the actual sends are
            # deferred below, like the Sheets relay.
            breaches = _check_breaches_and_dispatch(station_severity, payload)
        else:
            text = await request.body()
            if not text:
                return JSONResponse({"error": "missing body"}, status_code=400)

            parsed = parse_qs(text.decode("utf-8", errors="ignore"), keep_blank_values=True)
            water_level = parsed.get("water_level", [None])[0]
            if water_level is None:
                return JSONResponse({"error": "missing water_level"}, status_code=400)

            payload["water_level"] = int(float(water_level))

        if storage.enabled():
            await _save_station_state(station, calib, station_mode, station_severity)

        print(f"Received sensor update: {payload}")
        await broadcast_sensor_update(payload)
        if "temperature" in payload:
            # Google Sheets keeps logging the raw averaged turbidity ADC (its column header is
            # "Turbidity (raw ADC)"), independent of what unit the dashboards display.
            sheet_payload = {
                "source": payload["source"],
                "timestamp": payload["timestamp"],
                "station": station,
                "temperature": payload["temperature"],
                "turbidity": payload.get("turbidityRaw", payload["turbidity"]),
            }
            if "tds" in payload:
                sheet_payload["tds"] = payload["tds"]
            # Instantaneous flow rate only -- water usage (the daily cumulative total) is a
            # different shape/cadence (see storage.py's daily_usage table) that doesn't fit
            # this per-reading log, same reasoning google_apps_script.gs's insertReadingAtTop_
            # documents for its Flow Rate column.
            if "flowRate" in payload:
                sheet_payload["flowRate"] = payload["flowRate"]
            asyncio.create_task(relay_to_google_sheets(sheet_payload))

            if breaches:
                asyncio.create_task(dispatch_push_breaches(breaches, payload))
        return JSONResponse({"ok": True, "payload": payload})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
```

- [ ] **Step 4: Verify with a standalone script (in-process ASGI call, no live server needed)**

Task 4 hasn't run yet, so other routes (`/history`, `/calibration*`, `/ws/app`,
`/station/rename`, `/ai-report*`) still reference now-deleted globals and will fail to import.
Verify this task in isolation by exercising just the rewritten pieces directly (not via
`import main`, which would fail until Task 4 lands):

Write `...\scratchpad\verify_task3_update_logic.py`:

```python
import sys
sys.path.insert(0, r"C:\Users\Ace\Documents\projects\WaterQualityChecker")
import storage

assert storage.init("file:/tmp/verify_task3.db", "")

# Simulate what the new /update body does, function-by-function, since main.py itself
# can't be imported until Task 4 also lands (other routes still reference removed globals).
from main import apply_turbidity, apply_tds, apply_flow, _default_calibration, _check_breaches_and_dispatch

calib = _default_calibration()
calib["turbidity"]["points"] = [{"raw": 100, "reference": 50}, {"raw": 200, "reference": 10}]
from main import _recompute_turbidity
_recompute_turbidity(calib)
assert calib["turbidity"]["coefficients"] is not None

ntu = apply_turbidity(calib, 150)
assert ntu == 30.0, ntu

liters, rate = apply_flow(calib, False, 900)  # mode off -> nominal k=450
assert liters == 2.0 and rate == 60.0, (liters, rate)

severity = {}
breaches = _check_breaches_and_dispatch(severity, {"temperature": 45.0})
assert breaches, "expected a breach on an extreme temperature"
assert severity["temperature"] in ("warn", "danger")

storage.insert_reading("Inlet", 1000, {"temperature": 20.0})
storage.upsert_station_state("Inlet", calib, False, severity)
state = storage.get_station_state("Inlet")
assert state["lastSeverity"] == severity

print("Task 3 /update logic verification: ALL PASSED")
```

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe ...\scratchpad\verify_task3_update_logic.py`

Expected output: `Task 3 /update logic verification: ALL PASSED`

- [ ] **Step 5: Commit**

```bash
git add main.py
git commit -m "main.py: rewrite POST /update against Turso, remove retired in-memory globals"
```

---

### Task 4: `main.py` — rewrite `/history`, `/calibration*`, `/flow/*`, `/station/rename`, `/ai-report*`, and the `/ws/app` prime frame

**Files:**
- Modify: `main.py`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything Tasks 1-3 produced

- [ ] **Step 1: Rewrite `_with_ntu` to take a `calib` dict instead of a station name**

Replace:

```python
def _with_ntu(station: str, rows: list) -> list:
    # Each row's `turbidity` is raw ADC (matching the sheet). Add `turbidityNtu` = calibrated
    # NTU (or None if uncalibrated) so the dashboard stays consistent with the live WS value,
    # while `turbidity` keeps carrying the raw ADC.
    out = []
    for r in rows:
        adc = r.get("turbidity")
        ntu = apply_turbidity(station, adc) if isinstance(adc, (int, float)) else None
        # Sheet-backed rows (long windows) have no `ec` column -- derive it from tds so the
        # EC graph works across every window, not just the live in-memory ones.
        ec = r.get("ec")
        if ec is None:
            ec = ppm_to_ec(r.get("tds"))
        # Sheets rows carry flowRate once google_apps_script.gs has been redeployed with its
        # Flow Rate column (see CLAUDE.md); rows logged before that redeploy, or buffer rows
        # where a reading simply had no flow data, fall back to None here uniformly.
        flow_rate = r.get("flowRate")
        out.append({**r, "station": station, "turbidityNtu": ntu, "ec": ec, "flowRate": flow_rate})
    return out
```

with:

```python
def _with_ntu(calib: dict, station: str, rows: list) -> list:
    # Turso-backed rows already carry a computed turbidityNtu (set at insert time in
    # /update). Sheet-backed rows (long windows) only have raw `turbidity` -- compute NTU for
    # those here so both sources agree.
    out = []
    for r in rows:
        ntu = r.get("turbidityNtu")
        if ntu is None:
            adc = r.get("turbidity")
            ntu = apply_turbidity(calib, adc) if isinstance(adc, (int, float)) else None
        # Sheet-backed rows (long windows) have no `ec` column -- derive it from tds so the
        # EC graph works across every window.
        ec = r.get("ec")
        if ec is None:
            ec = ppm_to_ec(r.get("tds"))
        # Sheets rows carry flowRate once google_apps_script.gs has been redeployed with its
        # Flow Rate column (see CLAUDE.md); rows logged before that redeploy, or rows where a
        # reading simply had no flow data, fall back to None here uniformly.
        flow_rate = r.get("flowRate")
        out.append({**r, "station": station, "turbidityNtu": ntu, "ec": ec, "flowRate": flow_rate})
    return out
```

- [ ] **Step 2: Rewrite `GET /history`**

Replace the body of `get_history` from `cutoff_ms = ...` through the final `return`:

```python
    cutoff_ms = (time.time() - seconds) * 1000
    sources: list[str] = []

    # Tier 1 -- Turso `readings`, the whole live path (pruned to 24h -- see storage.py).
    rows = await asyncio.to_thread(storage.get_readings, station, cutoff_ms) if storage.enabled() else []
    if rows:
        sources.append("live")

    # Tier 2 -- Sheets fills the older end when Turso doesn't reach far enough back. The
    # tolerance keeps a normal steady-state request (oldest row a second or two after the
    # cutoff) from counting as a gap; see HISTORY_GAP_TOLERANCE_MS.
    local_floor_ms = rows[0]["timestamp"] if rows else float("inf")
    coverage_gap = (not rows) or (local_floor_ms > cutoff_ms + HISTORY_GAP_TOLERANCE_MS)

    if coverage_gap and GOOGLE_SHEETS_WEBHOOK_URL:
        sheet_rows, err = await _fetch_sheet_rows(seconds, cutoff_ms, HISTORY_MAX_POINTS, station)
        # Keep only rows strictly older than what Turso already covers, so the merge has no
        # duplicate/overlapping rows at the seam.
        sheet_rows = [r for r in sheet_rows if r["timestamp"] < local_floor_ms]
        if sheet_rows:
            rows = sheet_rows + rows  # both chronological ascending -> merge stays ordered
            sources.append("sheet")
        if err is not None and not rows:
            return JSONResponse(
                {"rows": [], "windowSeconds": seconds, "error": err, "source": "sheet"}
            )

    calib, _mode, _severity = await _load_station_state(station)
    return JSONResponse({
        "rows": _with_ntu(calib, station, _downsample(rows, HISTORY_MAX_POINTS)),
        "windowSeconds": seconds,
        "source": "+".join(sources) if sources else "none",
    })
```

- [ ] **Step 3: Rewrite the `/calibration*` endpoints**

Replace `_avg_raw`:

```python
async def _avg_raw(station: str, column: str):
    """`column` is one of the readings-table raw columns ("turbidity_raw", "tds_voltage",
    "flow_pulses"). Averages the last 5 non-null values; falls back to the single latest
    reading if fewer than 5 (or zero) are available."""
    if not storage.enabled():
        return None
    values = await asyncio.to_thread(storage.get_recent_raw, station, column, 5)
    if values:
        return sum(values) / len(values)
    latest = await asyncio.to_thread(storage.get_latest_reading, station)
    if not latest:
        return None
    key_map = {"turbidity_raw": "turbidity", "tds_voltage": "tdsVoltage", "flow_pulses": "flowPulses"}
    return latest.get(key_map[column])
```

Replace `GET /calibration`:

```python
@app.get("/calibration")
async def get_calibration(station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    calib, mode, _severity = await _load_station_state(station)
    latest = await asyncio.to_thread(storage.get_latest_reading, station) if storage.enabled() else None
    latest = latest or {}
    return JSONResponse(
        {
            "mode": mode,
            "turbidity": calib["turbidity"],
            "tds": calib["tds"],
            "flow": calib["flow"],
            "latestRaw": {
                "turbidity": latest.get("turbidity"),
                "tdsVoltage": latest.get("tdsVoltage"),
                "temperature": latest.get("temperature"),
                "flowRaw": latest.get("flowPulses"),
            },
        }
    )
```

Replace `POST /calibration/mode`:

```python
@app.post("/calibration/mode")
async def set_calibration_mode(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    calib, _old_mode, severity = await _load_station_state(station)
    mode = bool(body.get("enabled"))
    await _save_station_state(station, calib, mode, severity)
    return JSONResponse({"mode": mode})
```

`_RECOMPUTE_FNS` stays as-is (already maps sensor name -> the Task-2-refactored
`_recompute_*` functions, which now take `calib` — no change needed to the dict itself).

Replace `POST /calibration/capture`:

```python
@app.post("/calibration/capture")
async def capture_calibration_point(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in CALIBRATED_SENSORS:
        return JSONResponse({"error": "sensor must be 'turbidity', 'tds', or 'flow'"}, status_code=400)
    try:
        reference = float(body["reference"])
    except (KeyError, TypeError, ValueError):
        return JSONResponse({"error": "reference (numeric) is required"}, status_code=400)
    label = str(body.get("label", ""))

    raw_column = {"turbidity": "turbidity_raw", "tds": "tds_voltage", "flow": "flow_pulses"}[sensor]
    manual_raw = body.get("raw")
    if manual_raw is not None and manual_raw != "":
        try:
            raw = float(manual_raw)
        except (TypeError, ValueError):
            return JSONResponse({"error": "raw must be numeric"}, status_code=400)
    else:
        raw = await _avg_raw(station, raw_column)
        if raw is None:
            unit = {"turbidity": "Raw ADC", "tds": "Raw V", "flow": "pulse count"}[sensor]
            return JSONResponse(
                {"error": f"no live {sensor} reading yet — type a {unit} value instead"},
                status_code=409,
            )

    calib, mode, severity = await _load_station_state(station)
    latest = await asyncio.to_thread(storage.get_latest_reading, station) if storage.enabled() else None
    latest = latest or {}
    if sensor == "turbidity":
        calib["turbidity"]["points"].append(
            {"raw": round(raw, 1), "reference": reference, "label": label}
        )
    elif sensor == "tds":
        calib["tds"]["points"].append(
            {
                "rawVoltage": round(raw, 4),
                "reference": reference,
                "label": label,
                "temperature": latest.get("temperature") if latest.get("temperature") is not None else 25.0,
            }
        )
    else:
        calib["flow"]["points"].append(
            {"rawPulses": round(raw, 1), "reference": reference, "label": label}
        )
    _RECOMPUTE_FNS[sensor](calib)
    # Captures are immediately live (no separate draft/Save step -- see the migration spec)
    # so this stamps `updated` right away rather than waiting for a POST /calibration/save.
    calib[sensor]["updated"] = _now_iso()
    await _save_station_state(station, calib, mode, severity)

    return JSONResponse({sensor: calib[sensor]})
```

Replace `DELETE /calibration/point`:

```python
@app.delete("/calibration/point")
async def delete_calibration_point(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in CALIBRATED_SENSORS:
        return JSONResponse({"error": "sensor must be 'turbidity', 'tds', or 'flow'"}, status_code=400)
    calib, mode, severity = await _load_station_state(station)
    try:
        index = int(body["index"])
        calib[sensor]["points"].pop(index)
    except (KeyError, TypeError, ValueError, IndexError):
        return JSONResponse({"error": "valid point index required"}, status_code=400)
    _RECOMPUTE_FNS[sensor](calib)
    calib[sensor]["updated"] = _now_iso()
    await _save_station_state(station, calib, mode, severity)
    return JSONResponse({sensor: calib[sensor]})
```

Replace `POST /calibration/save` (its job narrows now that captures are already live —
see the migration spec's Calibration UX section):

```python
@app.post("/calibration/save")
async def save_calibration(station: str = DEFAULT_STATION):
    # Every capture already persists immediately (see /calibration/capture above) -- this
    # endpoint's only remaining job is stamping every sensor's `updated` timestamp, kept for
    # the frontend's existing Save button to still do something meaningful.
    station = _normalize_station(station)
    calib, mode, severity = await _load_station_state(station)
    now = _now_iso()
    for sensor in CALIBRATED_SENSORS:
        calib[sensor]["updated"] = now
    await _save_station_state(station, calib, mode, severity)
    print(f"💾 Calibration confirmed (station={station!r})")
    return JSONResponse({"ok": True, **{s: calib[s] for s in CALIBRATED_SENSORS}})
```

Replace `POST /calibration/reset`:

```python
@app.post("/calibration/reset")
async def reset_calibration(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in CALIBRATED_SENSORS:
        return JSONResponse({"error": "sensor must be 'turbidity', 'tds', or 'flow'"}, status_code=400)
    calib, mode, severity = await _load_station_state(station)
    calib[sensor] = _default_calibration()[sensor]
    await _save_station_state(station, calib, mode, severity)
    return JSONResponse({sensor: calib[sensor]})
```

- [ ] **Step 4: Rewrite `/flow/usage` and `/flow/reset-today`**

```python
@app.get("/flow/usage")
async def get_flow_usage(days: int = 14, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    if not storage.enabled():
        return JSONResponse({"today": 0.0, "days": []})
    days = max(1, min(days, 365))
    today_total = await asyncio.to_thread(storage.get_daily_usage, _local_date(), station)
    rows = await asyncio.to_thread(storage.get_recent_daily_usage, station, days)
    return JSONResponse({"today": round(today_total, 4), "days": rows})


@app.post("/flow/reset-today")
async def reset_flow_usage_today(station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    if storage.enabled():
        await asyncio.to_thread(storage.reset_daily_usage, _local_date(), station)
    return JSONResponse({"ok": True, "today": 0.0})
```

- [ ] **Step 5: Rewrite the AI daily report prompt-builder + generator + scheduler**

Replace `_build_daily_report_prompt`:

```python
def _local_midnight_ms() -> int:
    now = datetime.datetime.now()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(midnight.timestamp() * 1000)


async def _build_daily_report_prompt(station: str) -> str:
    since_ms = _local_midnight_ms()
    _calib, station_mode, _severity = await _load_station_state(station)
    # Same per-station unit choice /update's own sensor_stats query makes -- NTU once
    # calibrated, else raw ADC.
    columns = {
        "temperature": "temperature",
        "turbidity": "turbidity_ntu" if station_mode else "turbidity_raw",
        "tds": "tds_ppm",
        "ec": "ec",
    }
    extremes = await asyncio.to_thread(
        storage.get_reading_extremes, station, since_ms, tuple(columns.values())
    )
    lines = [
        "สรุปสถานการณ์คุณภาพน้ำวันนี้ให้สั้น กระชับ เข้าใจง่าย เป็นภาษาไทย 3-5 ประโยค "
        "สำหรับผู้บริหารสถานศึกษาที่ไม่ใช่สายเทคนิค โดยเน้นว่าค่าที่วัดได้ปกติดีหรือมีจุดที่ควรเฝ้าระวัง:"
    ]
    for param in PUSH_PARAMS:
        col = columns.get(param)
        stat = extremes.get(col) if col else None
        if not stat:
            continue
        _emoji, label, unit = PARAM_DISPLAY.get(param, ("", param.capitalize(), ""))
        values = await asyncio.to_thread(storage.get_reading_values, station, since_ms, col)
        breaches = sum(
            1
            for v in values
            if not thresholds.is_sensor_fault(param, v)
            and thresholds.range_status_for(param, v) in ("warn", "danger")
        )
        lines.append(
            f"- {label}: ต่ำสุด {stat['min']:.1f}, สูงสุด {stat['max']:.1f}, "
            f"เฉลี่ย {stat['avg']:.1f} {unit}, เกินเกณฑ์เฝ้าระวัง/อันตราย {breaches} ครั้งจาก {stat['count']} ครั้งที่วัด"
        )
    return "\n".join(lines)
```

In `_generate_ai_report`, change `prompt = _build_daily_report_prompt(station)` to
`prompt = await _build_daily_report_prompt(station)` (the function is now async).

Replace `_daily_report_scheduler`:

```python
async def _daily_report_scheduler() -> None:
    while True:
        await asyncio.sleep(await _seconds_until_next_midnight())
        stations_to_report = await asyncio.to_thread(storage.list_stations) if storage.enabled() else []
        for station in stations_to_report:
            await _generate_ai_report(station)
```

`GET /ai-report` and `POST /ai-report/generate` are unchanged — they already only call
`storage.get_latest_ai_report`/`_generate_ai_report`, neither of which touched the removed
globals directly.

- [ ] **Step 6: Rewrite `POST /station/rename`**

Replace the function body from `old_exists = ...` to the end:

```python
    if not storage.enabled():
        return JSONResponse(
            {"error": "station rename requires the Turso database to be enabled"}, status_code=503
        )

    old_exists = await asyncio.to_thread(storage.station_exists, old)
    if not old_exists:
        return JSONResponse({"error": f'station "{old}" not found'}, status_code=404)

    new_exists = await asyncio.to_thread(storage.station_exists, new)
    if new_exists:
        return JSONResponse({"error": f'station "{new}" already exists'}, status_code=409)

    await asyncio.to_thread(storage.rename_readings, old, new)
    await asyncio.to_thread(storage.rename_station_state, old, new)
    await asyncio.to_thread(storage.rename_station_usage, old, new)
    await asyncio.to_thread(storage.rename_ai_reports, old, new)

    await broadcast_station_renamed(old, new)

    print(f"✏️ Renamed station {old!r} -> {new!r}")
    return JSONResponse({"old": old, "new": new})
```

(The earlier validation lines above `old_exists = ...` — the `old`/`new` normalization,
reserved-name check, equality check — are untouched.)

- [ ] **Step 7: Rewrite the `/ws/app` prime-frame logic**

Replace from `stations_with_data = [s for s, buf in history_buffer.items() if buf]` through
the end of the `else:` block (just before `try: while True: await websocket.receive_text()`):

```python
    stations_with_data = await asyncio.to_thread(storage.list_stations) if storage.enabled() else []

    if not stations_with_data:
        try:
            await websocket.send_text(json.dumps({
                "type": "sensor_update",
                "payload": {"stats": None, "hasData": False, "lastTimestamp": None},
            }))
        except Exception:
            pass
    else:
        for station in stations_with_data:
            last = await asyncio.to_thread(storage.get_latest_reading, station)
            if last is None:
                continue
            calib, station_mode, _severity = await _load_station_state(station)
            turbidity_adc = last.get("turbidity")
            ntu = last.get("turbidityNtu")
            if ntu is None and station_mode and turbidity_adc is not None:
                ntu = apply_turbidity(calib, turbidity_adc)
            stat_columns = {
                "temperature": "temperature",
                "turbidity": "turbidity_ntu" if station_mode else "turbidity_raw",
                "tds": "tds_ppm",
                "flowRate": "flow_rate",
            }
            extremes = await asyncio.to_thread(
                storage.get_reading_extremes, station, 0, tuple(set(stat_columns.values()))
            )
            stats = {
                key: {"min": extremes[col]["min"], "max": extremes[col]["max"]}
                for key, col in stat_columns.items()
                if col in extremes
            }
            prime_payload = {
                "stats": stats or None,
                "hasData": True,
                # SECONDS (epoch), matching the WS `timestamp` convention used by /update.
                "lastTimestamp": last["timestamp"] // 1000,
                "source": "prime",
                "station": station,
                "timestamp": last["timestamp"] // 1000,
                "temperature": last.get("temperature"),
                "turbidityRaw": turbidity_adc,
                "turbidityNtu": ntu,
                "turbidity": ntu if ntu is not None else turbidity_adc,
                "turbidityUnit": "NTU" if ntu is not None else "ADC",
                "tds": last.get("tds"),
            }
            try:
                await websocket.send_text(
                    json.dumps({"type": "sensor_update", "payload": prime_payload})
                )
            except Exception:
                break
```

- [ ] **Step 8: Update `_daily_report_scheduler`'s stale comment cross-reference**

`start_daily_report_scheduler`'s docstring/comment block is unaffected. But check the
`_daily_report_scheduler` doc comment above it (the one currently reading "same expression
websocket_app already uses... to decide which stations to prime") is still accurate after
Step 7/5 — it is (both now call `storage.list_stations()`), so no edit needed there beyond
confirming during review.

- [ ] **Step 9: Confirm the whole file imports and starts cleanly**

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import main"` from the repo root (with `webconfig.json`'s `tursoDatabaseUrl` left empty/unset is fine — every route degrades gracefully per the `storage.enabled()` guards added throughout).

Expected: prints the normal startup banner lines (Google Sheets/Turso/Gemini
enabled-or-disabled messages) and exits 0 with no traceback. A traceback here means a
leftover reference to one of Task 1-3's removed globals — grep for
`history_buffer|sensor_stats|last_severity\b|latest_raw|_raw_buffers|_daily_usage_totals|_daily_usage_seeded|PER_STATION_MAPS|_station_calibration\b|_station_calibration_mode|calibration\[|calibration_mode\[` across `main.py` and fix any hit.

- [ ] **Step 10: End-to-end verification with a real local Turso file**

Write `...\scratchpad\verify_task4_e2e.py` exercising the FastAPI app in-process via
`starlette.testclient.TestClient` (already an installed transitive dependency of FastAPI, no
new package needed):

```python
import sys, os
sys.path.insert(0, r"C:\Users\Ace\Documents\projects\WaterQualityChecker")
os.chdir(r"C:\Users\Ace\Documents\projects\WaterQualityChecker")

import json
with open("webconfig.json", encoding="utf-8") as f:
    cfg = json.load(f)
cfg["tursoDatabaseUrl"] = "file:/tmp/verify_task4.db"
with open("webconfig.json", "w", encoding="utf-8") as f:
    json.dump(cfg, f)

from starlette.testclient import TestClient
import main

client = TestClient(main.app)

r = client.post("/update", json={"temperature": 25.0, "turbidity": 120, "tdsVoltage": 1.2, "flowPulses": 900, "station": "Inlet"})
assert r.status_code == 200, r.text
body = r.json()["payload"]
assert body["station"] == "Inlet"
assert body["waterUsageToday"] == 2.0, body  # 900/450 = 2 liters, k default since mode is off

r = client.get("/history", params={"window": "5m", "station": "Inlet"})
assert r.status_code == 200, r.text
rows = r.json()["rows"]
assert len(rows) == 1 and rows[0]["temperature"] == 25.0, rows

r = client.post("/calibration/capture", json={"sensor": "turbidity", "reference": 5.0, "raw": 100})
r2 = client.post("/calibration/capture", params={"station": "Inlet"}, json={"sensor": "turbidity", "reference": 5.0, "raw": 100})
assert r2.status_code == 200, r2.text
r3 = client.post("/calibration/capture", params={"station": "Inlet"}, json={"sensor": "turbidity", "reference": 1.0, "raw": 200})
assert r3.status_code == 200, r3.text
r4 = client.get("/calibration", params={"station": "Inlet"})
calib = r4.json()
assert calib["turbidity"]["coefficients"] is not None, calib

r = client.post("/station/rename", json={"old": "Inlet", "new": "Inlet2"})
assert r.status_code == 200, r.text

r = client.get("/flow/usage", params={"station": "Inlet2"})
assert r.status_code == 200 and r.json()["today"] > 0, r.text

print("Task 4 end-to-end verification: ALL PASSED")
```

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe ...\scratchpad\verify_task4_e2e.py`

Expected output: `Task 4 end-to-end verification: ALL PASSED`

Afterward, revert the test script's `webconfig.json` edit: `git checkout -- webconfig.json`.

- [ ] **Step 11: Update CLAUDE.md**

In the "Sensor calibration (backend-owned)" section, replace the sentence "Calibration lives
on the backend, not the firmware, so sensors recalibrate live with **no reflash**. The
firmware streams raw values; `main.py` converts them via coefficients in `calibration.json`"
with: "Calibration lives on the backend, not the firmware, so sensors recalibrate live with
**no reflash**. The firmware streams raw values; `main.py` converts them via coefficients
stored per-station in Turso's `station_state` table (`storage.py`) — `calibration.json` no
longer exists."

Replace the "Calibration mode gate" bullet's reference to captures being held until an
explicit Save with: "**Calibration mode gate**: saved coefficients apply only when
`calibration_mode` is ON (the frontend Calibration tab's toggle, `POST /calibration/mode`).
Every capture is immediately live (persisted to Turso the moment `POST
/calibration/capture` runs, no separate draft/Save step) — `POST /calibration/save` now only
stamps each sensor's `updated` timestamp. OFF → `/update` always emits raw ADC
(`turbidityUnit: "ADC"`) and uncalibrated ppm (k=1.0)."

Add a note to the "Architecture (main.py / FastAPI path)" section's Config bullet, removing
any remaining reference to `calibrationFile`/`historyDbFile` if still present (both are gone
— `historyDbFile` was already renamed to `tursoDatabaseUrl` in sub-project #2).

Update the "Autoreload is opt-in" caveat paragraph: it currently says a reload would wipe
"`history_buffer`/`sensor_stats` each time" — replace with: "would restart the server,
dropping all dashboard WebSockets — reading history, calibration, and daily usage all live in
Turso now (this sub-project), so a restart no longer loses them, only the live WebSocket
connections themselves."

- [ ] **Step 12: Commit**

```bash
git add main.py CLAUDE.md
git commit -m "main.py: migrate /history, /calibration*, /flow/*, /station/rename, /ai-report*, /ws/app prime frame to Turso"
```
