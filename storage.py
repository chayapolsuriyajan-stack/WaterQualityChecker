"""Local SQLite persistence for sensor readings.

WHY THIS EXISTS: before this module, history had exactly two tiers -- an in-memory buffer
(wiped on every restart) and Google Sheets (a network round-trip to a third party, with a
row cap and no offline story). Anything past the buffer window depended on a Google
deployment being reachable and correctly redeployed.

SQLite sits between them: every reading is written locally as it arrives, so `/history`
can answer any window from disk, instantly, with no network and no Google account. Sheets
is unchanged and still the shareable/inspectable copy -- this is an addition, not a
replacement, and the sheet remains the fallback when the local DB has a coverage gap (e.g.
readings collected while the DB was disabled, or a database restored onto a fresh machine).

Design notes:
- One module-level connection with `check_same_thread=False`, guarded by a lock. Every
  public function here is blocking, and `main.py` calls them via `asyncio.to_thread` so a
  slow disk never stalls the event loop or the ESP32's `/update` response.
- WAL journal mode so the write on each reading doesn't block concurrent `/history` reads.
- Column names deliberately mirror the row shape used by `history_buffer` and the Apps
  Script's `doGet` (`timestamp` in epoch MILLISECONDS, `turbidity` = raw ADC), so rows from
  all three sources merge without translation.
"""

import json
import os
import sqlite3
import threading
import time

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    timestamp_ms INTEGER NOT NULL,
    temperature  REAL,
    turbidity    REAL,   -- raw averaged ADC, matching the sheet's "Turbidity (raw ADC)" column
    tds          REAL,   -- calibrated ppm
    ec           REAL,   -- derived from tds; stored so reads don't re-derive it
    flow_rate    REAL    -- calibrated L/min, instantaneous (see daily_usage for cumulative)
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (timestamp_ms);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    prefs_json  TEXT NOT NULL,  -- e.g. {"temperature": {"warn": bool, "danger": bool}, ...}
    created_ms  INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
);

-- One row per local calendar day (YYYY-MM-DD), total_liters accumulated as readings arrive.
-- A day rollover just starts a new row -- that alone gives the flow sensor's "daily usage"
-- an automatic reset with no scheduler needed. Kept indefinitely (not subject to
-- historyRetentionDays -- one tiny row/day, unlike the 2s-cadence readings table).
CREATE TABLE IF NOT EXISTS daily_usage (
    date         TEXT PRIMARY KEY,
    total_liters REAL NOT NULL DEFAULT 0
);
"""

# readings.flow_rate was added after the initial release -- CREATE TABLE IF NOT EXISTS won't
# retrofit it onto an existing history.db, so add it explicitly and swallow the "duplicate
# column" error on every subsequent startup once it's already there.
_MIGRATIONS = [
    "ALTER TABLE readings ADD COLUMN flow_rate REAL",
]


def init(path: str) -> bool:
    """Open (creating if needed) the history database. Returns False if unusable.

    A failure here is never fatal: main.py degrades to the previous buffer+Sheets behavior,
    because losing local persistence is much better than refusing to monitor the water.
    """
    global _conn
    try:
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        conn = sqlite3.connect(path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # WAL: concurrent reads during writes. synchronous=NORMAL: safe under WAL for our
        # durability needs (a reading lost to a power cut is already lost on the ESP32 side)
        # and avoids an fsync every 2 seconds on the same disk the OS is running from.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.executescript(_SCHEMA)
        conn.commit()
        for migration in _MIGRATIONS:
            try:
                conn.execute(migration)
                conn.commit()
            except sqlite3.OperationalError:
                pass  # column already exists -- already-migrated DB, nothing to do
        _conn = conn
        return True
    except Exception as exc:  # sqlite3.Error, OSError, permissions...
        print(f"⚠️ History database unavailable at {path}: {exc}")
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


def insert(row: dict) -> None:
    """Append one reading. `row` uses the history_buffer shape (timestamp in epoch ms)."""
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute(
                "INSERT INTO readings (timestamp_ms, temperature, turbidity, tds, ec, flow_rate)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    int(row["timestamp"]),
                    row.get("temperature"),
                    row.get("turbidity"),
                    row.get("tds"),
                    row.get("ec"),
                    row.get("flowRate"),
                ),
            )
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ History database write failed: {exc}")


def query(cutoff_ms: float) -> list[dict]:
    """All readings at/after `cutoff_ms`, chronological ascending.

    Returns the full window undownsampled -- main.py applies the same `_downsample` stride
    every other source goes through, so all three history sources stay consistent.
    """
    if _conn is None:
        return []
    try:
        with _lock:
            cur = _conn.execute(
                "SELECT timestamp_ms, temperature, turbidity, tds, ec, flow_rate FROM readings"
                " WHERE timestamp_ms >= ? ORDER BY timestamp_ms ASC",
                (int(cutoff_ms),),
            )
            rows = cur.fetchall()
    except Exception as exc:
        print(f"⚠️ History database read failed: {exc}")
        return []

    return [
        {
            "timestamp": r["timestamp_ms"],
            "temperature": r["temperature"],
            "turbidity": r["turbidity"],
            "tds": r["tds"],
            "ec": r["ec"],
            "flowRate": r["flow_rate"],
        }
        for r in rows
    ]


def oldest_ms() -> int | None:
    """Timestamp of the earliest stored reading, or None when the table is empty.

    Used to detect a coverage gap: if the DB's oldest row is newer than the requested
    window's cutoff, the DB alone can't answer the window and Sheets fills the older part.
    """
    if _conn is None:
        return None
    try:
        with _lock:
            cur = _conn.execute("SELECT MIN(timestamp_ms) AS m FROM readings")
            row = cur.fetchone()
    except Exception as exc:
        print(f"⚠️ History database read failed: {exc}")
        return None
    return row["m"] if row and row["m"] is not None else None


def count() -> int:
    if _conn is None:
        return 0
    try:
        with _lock:
            return _conn.execute("SELECT COUNT(*) AS c FROM readings").fetchone()["c"]
    except Exception:
        return 0


def prune(retention_days: int) -> int:
    """Delete readings older than `retention_days`. Returns rows removed; 0 disables pruning.

    At one reading per 2 seconds a year is ~15M rows -- fine for SQLite, but the file grows
    unbounded on a machine that is also somebody's PC. VACUUM is deliberately NOT run here:
    it rewrites the whole file and would block writes for seconds on a large database.
    """
    if _conn is None or retention_days <= 0:
        return 0
    cutoff_ms = int((time.time() - retention_days * 86400) * 1000)
    try:
        with _lock:
            cur = _conn.execute("DELETE FROM readings WHERE timestamp_ms < ?", (cutoff_ms,))
            _conn.commit()
            return cur.rowcount or 0
    except Exception as exc:
        print(f"⚠️ History database prune failed: {exc}")
        return 0


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


def add_daily_usage(date: str, liters: float) -> None:
    """Adds `liters` to `date`'s running total (creating the row if this is its first reading
    of the day). `date` is a local YYYY-MM-DD string, caller-supplied so this module doesn't
    need to know about timezones."""
    if _conn is None or liters is None:
        return
    try:
        with _lock:
            _conn.execute(
                "INSERT INTO daily_usage (date, total_liters) VALUES (?, ?)"
                " ON CONFLICT(date) DO UPDATE SET total_liters = total_liters + excluded.total_liters",
                (date, liters),
            )
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Daily usage write failed: {exc}")


def get_daily_usage(date: str) -> float:
    """Today's (or any given date's) total, 0 if no reading has landed yet."""
    if _conn is None:
        return 0.0
    try:
        with _lock:
            row = _conn.execute(
                "SELECT total_liters FROM daily_usage WHERE date = ?", (date,)
            ).fetchone()
    except Exception as exc:
        print(f"⚠️ Daily usage read failed: {exc}")
        return 0.0
    return row["total_liters"] if row else 0.0


def get_recent_daily_usage(days: int) -> list[dict]:
    """Last `days` calendar days with a recorded row, chronological ascending -- for the
    Water Usage bar chart. Days with no readings simply have no row (no zero-filling here;
    the frontend can decide how to render gaps)."""
    if _conn is None:
        return []
    try:
        with _lock:
            rows = _conn.execute(
                "SELECT date, total_liters FROM daily_usage ORDER BY date DESC LIMIT ?",
                (days,),
            ).fetchall()
    except Exception as exc:
        print(f"⚠️ Daily usage read failed: {exc}")
        return []
    return [{"date": r["date"], "totalLiters": r["total_liters"]} for r in reversed(rows)]


def reset_daily_usage(date: str) -> None:
    """Zeroes `date`'s total (manual reset) -- upserts rather than deletes so a reset before
    any reading has landed today still leaves a 0 row instead of erroring on a missing one."""
    if _conn is None:
        return
    try:
        with _lock:
            _conn.execute(
                "INSERT INTO daily_usage (date, total_liters) VALUES (?, 0)"
                " ON CONFLICT(date) DO UPDATE SET total_liters = 0",
                (date,),
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
