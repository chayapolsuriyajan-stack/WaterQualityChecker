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
    ec           REAL    -- derived from tds; stored so reads don't re-derive it
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (timestamp_ms);
"""


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
                "INSERT INTO readings (timestamp_ms, temperature, turbidity, tds, ec)"
                " VALUES (?, ?, ?, ?, ?)",
                (
                    int(row["timestamp"]),
                    row.get("temperature"),
                    row.get("turbidity"),
                    row.get("tds"),
                    row.get("ec"),
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
                "SELECT timestamp_ms, temperature, turbidity, tds, ec FROM readings"
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
