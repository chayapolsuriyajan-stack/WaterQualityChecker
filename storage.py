"""Local SQLite persistence for push subscriptions and daily water usage.

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
import sqlite3
import threading
import time

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()

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
"""


def _migrate_daily_usage_schema(conn: sqlite3.Connection) -> None:
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


def init(path: str) -> bool:
    """Open (creating if needed) the local database. Returns False if unusable.

    A failure here is never fatal: main.py degrades gracefully -- push subscriptions simply
    have nowhere durable to live, and daily water usage stops persisting, but sensor readings
    and the rest of the app keep working normally.
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
        _migrate_daily_usage_schema(conn)
        _conn = conn
        return True
    except Exception as exc:  # sqlite3.Error, OSError, permissions...
        print(f"⚠️ Local database unavailable at {path}: {exc}")
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
