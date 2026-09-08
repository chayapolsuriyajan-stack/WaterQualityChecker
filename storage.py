"""Turso (libSQL) persistence for push subscriptions and daily water usage.

Sensor reading history is NOT stored here -- it lives in the in-memory `history_buffer`
(main.py) for the live short-window graph, and in Google Sheets (via google_apps_script.gs)
for anything older. This module exists only for the two things Sheets can't reasonably
hold: durable Web Push subscription state (so subscriptions survive a restart), and the
flow sensor's daily-resetting water-usage counter (a small aggregate, not a per-reading log).

Design notes:
- One module-level connection with `check_same_thread=False`, guarded by a lock. Every
  public function here is blocking, and `main.py` calls them via `asyncio.to_thread` so a
  slow disk never stalls the event loop or the ESP32's `/update` response.
- WAL journal mode so a write doesn't block a concurrent read.
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


def add_daily_usage(date: str, station: str, liters: float) -> None:
    """Adds `liters` to `station`'s running total for `date` (creating the row if this is
    its first reading of the day). `date` is a local YYYY-MM-DD string, caller-supplied so
    this module doesn't need to know about timezones."""
    if _conn is None or liters is None:
        return
    try:
        with _lock:
            _conn.execute(
                "INSERT INTO daily_usage (date, station, total_liters) VALUES (?, ?, ?)"
                " ON CONFLICT(date, station) DO UPDATE SET total_liters = total_liters + excluded.total_liters",
                (date, station, liters),
            )
            _conn.commit()
    except Exception as exc:
        print(f"⚠️ Daily usage write failed: {exc}")


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
    """True if `station` has any daily_usage row at all (any date) -- used by
    main.py's /station/rename to detect a name collision even for a station whose
    in-memory state was wiped by a restart but still has historical usage on disk."""
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
    already confirmed `new` has zero existing rows (via station_has_usage) -- this
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
