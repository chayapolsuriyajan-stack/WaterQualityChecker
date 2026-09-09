"""Turso (libSQL) persistence for sensor readings, per-station state, push subscriptions,
and daily water usage.

Design notes:
- One module-level connection with `check_same_thread=False`, guarded by a lock. Every
  public function here is blocking, and `main.py` calls them via `asyncio.to_thread` so a
  slow network round-trip never stalls the event loop or the ESP32's `/update` response.
- The `readings` table is pruned to the last 24h by main.py (see prune_readings) --
  Google Sheets remains the durable long-term archive for anything older.
"""

import json
import os
import threading
import time

import libsql

_conn = None  # type: ignore[no-redef]  -- libsql's connection type, no public type stub as of writing
_lock = threading.Lock()


class _Row:
    """Minimal dict-style row adapter. libsql's cursor (confirmed by inspection --
    Step 1 of the Turso migration) returns plain tuples, not sqlite3.Row-like objects and
    has no `row_factory` support at all, so this maps column names (from the cursor's
    DB-API `description`) onto tuple values -- the only thing needed to keep every
    `row["column"]` access below unchanged."""

    __slots__ = ("_cols", "_values")

    def __init__(self, cols: list[str], values: tuple) -> None:
        self._cols = cols
        self._values = values

    def __getitem__(self, key):
        if isinstance(key, str):
            return self._values[self._cols.index(key)]
        return self._values[key]

    def __repr__(self) -> str:  # pragma: no cover -- debugging aid only
        return repr(dict(zip(self._cols, self._values)))


class _CursorWrapper:
    """Wraps a libsql cursor so `fetchone`/`fetchall` return `_Row` objects instead of
    plain tuples."""

    __slots__ = ("_cursor",)

    def __init__(self, cursor) -> None:
        self._cursor = cursor

    def _cols(self) -> list[str]:
        return [d[0] for d in (self._cursor.description or [])]

    def fetchall(self) -> list[_Row]:
        cols = self._cols()
        return [_Row(cols, row) for row in self._cursor.fetchall()]

    def fetchone(self):
        row = self._cursor.fetchone()
        return _Row(self._cols(), row) if row is not None else None

    @property
    def rowcount(self) -> int:
        return self._cursor.rowcount


class _ConnWrapper:
    """Wraps the raw libsql connection so every `.execute()` call returns rows supporting
    `row["column"]` access, matching the `sqlite3.Row` behavior the rest of this file's
    queries were written against -- libsql itself has no row_factory equivalent (see the
    `_Row`/`_CursorWrapper` docstrings above)."""

    __slots__ = ("_conn",)

    def __init__(self, conn) -> None:
        self._conn = conn

    def execute(self, sql: str, params=()) -> _CursorWrapper:
        return _CursorWrapper(self._conn.execute(sql, params))

    def executescript(self, sql: str) -> None:
        self._conn.executescript(sql)

    def commit(self) -> None:
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()


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

_SCHEMA = """
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    prefs_json  TEXT NOT NULL,  -- e.g. {"temperature": {"warn": bool, "danger": bool}, ...}
    created_ms  INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
);

-- One row per (local calendar day, station), total_liters accumulated as readings arrive.
-- A day rollover just starts fresh rows -- that alone gives the flow sensor's "daily usage"
-- an automatic per-station reset with no scheduler needed. Kept indefinitely.
CREATE TABLE IF NOT EXISTS daily_usage (
    date         TEXT NOT NULL,
    station      TEXT NOT NULL DEFAULT 'default',
    total_liters REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (date, station)
);

-- One row per (local calendar day, station): the Gemini-generated plain-language daily
-- water-quality summary (main.py's `_generate_ai_report`), keyed the same way as
-- daily_usage. Overwritten in place if the manual "Generate now" button re-runs the same
-- day (see save_ai_report's ON CONFLICT below). Kept indefinitely -- it's a small text blob.
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


def _migrate_daily_usage_schema(conn) -> None:
    """`daily_usage` used to be keyed by `date` alone (one implicit station). If an
    existing database still has that shape (no `station` column), rebuild the table with
    the new composite (date, station) key, attributing every existing row to 'default' --
    a plain ALTER TABLE ADD COLUMN can't fix the primary key, so this needs a real rebuild.
    A fresh database already gets the new shape from _SCHEMA above, so this is a no-op then.
    """
    cols = [row["name"] for row in conn.execute("PRAGMA table_info(daily_usage)").fetchall()]
    if not cols or "station" in cols:
        return
    conn.execute("ALTER TABLE daily_usage RENAME TO daily_usage_premigration")
    conn.executescript(_SCHEMA)  # recreates daily_usage in the new shape
    conn.execute(
        "INSERT INTO daily_usage (date, station, total_liters)"
        " SELECT date, 'default', total_liters FROM daily_usage_premigration"
    )
    conn.execute("DROP TABLE daily_usage_premigration")
    conn.commit()
    print("📦 Migrated daily_usage to per-station schema (existing rows attributed to 'default').")


def init(url: str, auth_token: str) -> bool:
    """Open a connection to the Turso (libSQL) database at `url`. Returns False if unusable.

    A failure here is never fatal: main.py degrades gracefully -- push subscriptions simply
    have nowhere durable to live, and daily water usage stops persisting, but sensor readings
    and the rest of the app keep working normally.
    """
    global _conn
    if not url:
        _conn = None
        return False
    try:
        raw = libsql.connect(database=url, auth_token=auth_token, _check_same_thread=False)
        # No journal_mode/synchronous pragmas here -- those tune LOCAL file durability/
        # concurrency behavior; Turso manages this server-side for a remote connection.
        conn = _ConnWrapper(raw)
        conn.executescript(_SCHEMA)
        conn.commit()
        _migrate_daily_usage_schema(conn)
        _conn = conn
        return True
    except Exception as exc:
        print(f"⚠️ Turso database unavailable at {url}: {exc}")
        _conn = None
        return False


def enabled() -> bool:
    return _conn is not None


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None


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


def update_last_severity(station: str, last_severity: dict, default_calibration_json: str = "{}") -> None:
    """Updates ONLY a station's breach edge-detection state, leaving calibration/mode alone
    if the station already has a row. `default_calibration_json` supplies a valid calibration
    shape for the INSERT-only branch (a station's very first ever station_state write, which
    normally happens via /update before anyone has touched the Calibration tab) -- passing
    '{}' here would leave the row with an empty calibration dict that later crashes any
    consumer indexing into calib["turbidity"]/["tds"]/["flow"]. Splitting this from
    upsert_station_state prevents /update's every-2s write from racing with a concurrent
    /calibration* endpoint's read-modify-write of the same row (both would otherwise replace
    the whole row, and whichever write lands second silently discards the other's change --
    e.g. a just-captured calibration point reverting because /update saved a stale calib dict
    it loaded before the capture)."""
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute(
                "INSERT INTO station_state (station, calibration_json, calibration_mode, last_severity_json)"
                " VALUES (?, ?, 0, ?)"
                " ON CONFLICT(station) DO UPDATE SET last_severity_json = excluded.last_severity_json",
                (station, default_calibration_json, json.dumps(last_severity)),
            )
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Station severity update failed: {exc}")


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


def upsert_push_subscription(endpoint: str, p256dh: str, auth: str, prefs: dict) -> None:
    """Insert or update one push subscription. `prefs` is stored as one JSON blob per
    subscription since it's always read/written whole, never queried by field."""
    if _conn is None:
        return
    try:
        now_ms = int(time.time() * 1000)
        with _lock:
            _conn.execute(
                "INSERT INTO push_subscriptions (endpoint, p256dh, auth, prefs_json, created_ms, updated_ms)"
                " VALUES (?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(endpoint) DO UPDATE SET"
                " p256dh=excluded.p256dh, auth=excluded.auth,"
                " prefs_json=excluded.prefs_json, updated_ms=excluded.updated_ms",
                (endpoint, p256dh, auth, json.dumps(prefs), now_ms, now_ms),
            )
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Push subscription upsert failed: {exc}")


def delete_push_subscription(endpoint: str) -> None:
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Push subscription delete failed: {exc}")


def get_all_push_subscriptions() -> list[dict]:
    if _conn is None:
        return []
    try:
        with _lock:
            cur = _conn.execute("SELECT endpoint, p256dh, auth, prefs_json FROM push_subscriptions")
            rows = cur.fetchall()
    except Exception as exc:
        print(f"⚠️ Push subscription read failed: {exc}")
        return []

    out = []
    for r in rows:
        try:
            prefs = json.loads(r["prefs_json"])
        except (TypeError, ValueError):
            prefs = {}
        out.append({"endpoint": r["endpoint"], "p256dh": r["p256dh"], "auth": r["auth"], "prefs": prefs})
    return out


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


def get_daily_usage(date: str, station: str) -> float:
    """`station`'s total for today (or any given date), 0 if no reading has landed yet."""
    if _conn is None:
        return 0.0
    try:
        with _lock:
            row = _conn.execute(
                "SELECT total_liters FROM daily_usage WHERE date = ? AND station = ?", (date, station)
            ).fetchone()
    except Exception as exc:
        print(f"⚠️ Daily usage read failed: {exc}")
        return 0.0
    return row["total_liters"] if row else 0.0


def get_recent_daily_usage(station: str, days: int) -> list[dict]:
    """`station`'s last `days` calendar days with a recorded row, chronological ascending --
    for the Water Usage bar chart. Days with no readings simply have no row (no zero-filling
    here; the frontend can decide how to render gaps)."""
    if _conn is None:
        return []
    try:
        with _lock:
            rows = _conn.execute(
                "SELECT date, total_liters FROM daily_usage WHERE station = ? ORDER BY date DESC LIMIT ?",
                (station, days),
            ).fetchall()
    except Exception as exc:
        print(f"⚠️ Daily usage read failed: {exc}")
        return []
    return [{"date": r["date"], "totalLiters": r["total_liters"]} for r in reversed(rows)]


def reset_daily_usage(date: str, station: str) -> None:
    """Zeroes `station`'s total for `date` (manual reset) -- upserts rather than deletes so
    a reset before any reading has landed today still leaves a 0 row instead of erroring on
    a missing one."""
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute(
                "INSERT INTO daily_usage (date, station, total_liters) VALUES (?, ?, 0)"
                " ON CONFLICT(date, station) DO UPDATE SET total_liters = 0",
                (date, station),
            )
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Daily usage reset failed: {exc}")


def update_push_prefs(endpoint: str, prefs: dict) -> bool:
    """Updates a subscription's prefs. Returns False if the endpoint isn't found."""
    if _conn is None:
        return False
    try:
        now_ms = int(time.time() * 1000)
        with _lock:
            cur = _conn.execute(
                "UPDATE push_subscriptions SET prefs_json = ?, updated_ms = ? WHERE endpoint = ?",
                (json.dumps(prefs), now_ms, endpoint),
            )
            _conn.commit()
            return cur.rowcount > 0
    except Exception as exc:
        print(f"⚠️ Push preference update failed: {exc}")
        return False


def station_has_usage(station: str) -> bool:
    """True if `station` has any daily_usage row at all (any date). Currently unused by
    main.py -- /station/rename was rewritten (Task 4) to use station_exists (below) for its
    collision check instead, which already covers daily_usage as one of its three UNIONed
    sources. Left in place in case a caller needs the daily_usage-only check specifically."""
    if _conn is None:
        return False
    try:
        with _lock:
            row = _conn.execute(
                "SELECT 1 FROM daily_usage WHERE station = ? LIMIT 1", (station,)
            ).fetchone()
    except Exception as exc:
        print(f"⚠️ Daily usage existence check failed: {exc}")
        return False
    return row is not None


def rename_station_usage(old: str, new: str) -> None:
    """Moves every daily_usage row from `old` to `new`. Caller (main.py) must have
    already confirmed `new` has zero existing rows (via station_exists) -- this
    does a plain UPDATE, which would violate the (date, station) primary key if `new`
    already had a row for some date `old` also has one for."""
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute("UPDATE daily_usage SET station = ? WHERE station = ?", (new, old))
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Daily usage rename failed: {exc}")


def rename_ai_reports(old: str, new: str) -> None:
    """Moves every ai_reports row from `old` to `new` -- same precondition as
    rename_station_usage: caller must have already confirmed `new` has no existing rows."""
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute("UPDATE ai_reports SET station = ? WHERE station = ?", (new, old))
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ AI report rename failed: {exc}")


def save_ai_report(date: str, station: str, report_text: str) -> None:
    """Insert or overwrite `station`'s AI daily report for `date` -- upsert so a manual
    "Generate now" re-run on the same day replaces the earlier one rather than erroring."""
    if _conn is None:
        return
    try:
        now_ms = int(time.time() * 1000)
        with _lock:
            _conn.execute(
                "INSERT INTO ai_reports (date, station, report_text, created_ms) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(date, station) DO UPDATE SET report_text = excluded.report_text,"
                " created_ms = excluded.created_ms",
                (date, station, report_text, now_ms),
            )
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ AI report write failed: {exc}")


def get_latest_ai_report(station: str) -> dict | None:
    """`station`'s most recently generated report (any date), or None if it has never had
    one -- survives a backend restart since it's read from disk, not in-memory state.
    `created_ms` (not just `date`) is included so main.py can enforce a cooldown between
    Gemini calls at sub-day granularity -- `date` alone can't tell "5 minutes ago" from
    "23 hours ago" on the same calendar day."""
    if _conn is None:
        return None
    try:
        with _lock:
            row = _conn.execute(
                "SELECT date, report_text, created_ms FROM ai_reports WHERE station = ? ORDER BY date DESC LIMIT 1",
                (station,),
            ).fetchone()
    except Exception as exc:
        print(f"⚠️ AI report read failed: {exc}")
        return None
    return (
        {"date": row["date"], "report": row["report_text"], "created_ms": row["created_ms"]}
        if row
        else None
    )
