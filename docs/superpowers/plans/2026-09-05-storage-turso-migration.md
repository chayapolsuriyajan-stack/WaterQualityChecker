# Storage Turso Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `storage.py`'s local SQLite connection with a Turso (libSQL) connection, keeping every table schema, query, and public function signature unchanged except `init()`.

**Architecture:** Single-file change to `storage.py` plus one call-site update in `main.py` and one config-key rename in `webconfig.json`. Turso's libSQL is SQLite-wire-compatible, so this is a connection-layer swap, not a query rewrite.

**Tech Stack:** Python, Turso/libSQL (exact package TBD-at-implementation, see Task 1 Step 1), FastAPI (`main.py`, unrelated but the one call site lives there).

## Global Constraints

- Every one of `storage.py`'s 13 public function bodies must be byte-for-byte unchanged in their SQL — only the connection object underneath changes.
- Turso auth token comes from environment variable `TURSO_AUTH_TOKEN`, never committed to a file. Database URL comes from `webconfig.json`'s `tursoDatabaseUrl` (not a secret on its own).
- No local-SQLite fallback path — Turso only, both dev and prod.
- No automated test suite exists in this repo. Verification requires a real Turso database; if none is available in the implementer's environment, live-connection tests are reported as unconfirmed, never fabricated.

---

### Task 1: Swap storage.py's connection layer to Turso

**Files:**
- Modify: `storage.py` (entire file — connection layer + `init()`; all 13 other function bodies stay textually identical)
- Modify: `main.py` — the one `storage.init(...)` call site (search `storage.init(` — currently `if HISTORY_DB_PATH and storage.init(HISTORY_DB_PATH):`)
- Modify: `webconfig.json` — rename `historyDbFile` key to `tursoDatabaseUrl`

**Interfaces:**
- Consumes: nothing from other tasks (this is the only task in this plan).
- Produces: `storage.init(url: str, auth_token: str) -> bool` (signature change from `init(path: str)`). Every other public function (`enabled`, `close`, `upsert_push_subscription`, `delete_push_subscription`, `get_all_push_subscriptions`, `add_daily_usage`, `get_daily_usage`, `get_recent_daily_usage`, `reset_daily_usage`, `update_push_prefs`, `station_has_usage`, `rename_station_usage`, `rename_ai_reports`, `save_ai_report`, `get_latest_ai_report`) keeps its exact existing signature — no caller outside `storage.py` needs to change beyond the one `init()` call site.

- [ ] **Step 1: Determine the actual current Turso Python package and confirm its API shape**

Package naming/API for Turso's Python SDK may have changed since this plan was written. Run:

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
.venv/Scripts/pip index versions libsql 2>&1
.venv/Scripts/pip index versions libsql-client 2>&1
```

Install whichever one is the current official Turso-recommended package (check
https://docs.turso.tech/sdk/python/quickstart for the current guidance — the package should
expose a synchronous `connect(database=<url>, auth_token=<token>)` function returning a
connection object supporting `.execute(sql, params)`, `.executescript(sql)`, `.commit()`,
`.close()`, and either a `.row_factory` attribute matching `sqlite3.Row`'s row-object
behavior, or a documented way to get column-name access on returned rows).

```bash
.venv/Scripts/pip install libsql
```

(Substitute the actual correct package name/install command if it differs from `libsql` —
report in your final report exactly which package and version you installed and why.)

Write a 5-line smoke-test script to confirm the package's `connect()`/`execute()`/`.row_factory`
behavior matches what Step 2 below assumes, BEFORE editing `storage.py` — if the real API
differs from this plan's assumptions (e.g. no `row_factory` support, different method names),
STOP and report NEEDS_CONTEXT with exactly what you found, rather than guessing an adapter.
You do not have real Turso credentials to test against yet (see Step 6) — for this smoke test,
confirm the import succeeds and the function signatures exist via `help()`/`inspect.signature()`,
not a live connection.

- [ ] **Step 2: Rewrite storage.py's imports and connection layer**

Open `storage.py`. Change the imports at the top from:

```python
import json
import os
import sqlite3
import threading
import time

_conn: sqlite3.Connection | None = None
```

to (adjust the `import libsql` line and the type annotation if Step 1 found a different
package name — keep everything else structurally identical):

```python
import json
import os
import threading
import time

import libsql

_conn = None  # type: ignore[no-redef]  -- libsql's connection type, no public type stub as of writing
```

- [ ] **Step 3: Rewrite `init()`**

Replace the entire current `init()` function:

```python
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
```

with:

```python
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
        conn = libsql.connect(database=url, auth_token=auth_token)
        # No journal_mode/synchronous pragmas here -- those tune LOCAL file durability/
        # concurrency behavior; Turso manages this server-side for a remote connection.
        conn.executescript(_SCHEMA)
        conn.commit()
        _migrate_daily_usage_schema(conn)
        _conn = conn
        return True
    except Exception as exc:
        print(f"⚠️ Turso database unavailable at {url}: {exc}")
        _conn = None
        return False
```

If Step 1 found that the chosen package's `connect()` does NOT support `.row_factory =
sqlite3.Row`-equivalent dict-style row access, add a row-adapter here instead of assuming it
works — but only if actually needed; check first.

- [ ] **Step 4: Update every remaining `sqlite3.` reference**

Search the rest of the file for any other `sqlite3.` reference (there should be exactly one
more, in `_migrate_daily_usage_schema`'s type hint):

```python
def _migrate_daily_usage_schema(conn: sqlite3.Connection) -> None:
```

Since `sqlite3` is no longer imported (Step 2 removed it), change this to drop the now-invalid
type annotation:

```python
def _migrate_daily_usage_schema(conn) -> None:
```

Confirm no other `sqlite3.` reference remains anywhere in the file:

```bash
grep -n "sqlite3" storage.py
```

Expected: no matches.

- [ ] **Step 5: Confirm every other function body is untouched**

This step is a verification, not an edit. Diff the file against its pre-Task-1 state for
everything below `_migrate_daily_usage_schema` and confirm the only differences are the type
hint fixed in Step 4 — every SQL string, every parameter tuple, every `with _lock:` block in
`upsert_push_subscription` through `get_latest_ai_report` must be identical to before this
task started. If you find yourself wanting to change any of their SQL, STOP — that would mean
Turso's dialect actually differs from what this plan assumed, and that's a NEEDS_CONTEXT
escalation, not something to quietly work around.

- [ ] **Step 6: Update main.py's call site**

Confirmed exact current state (`main.py:43-47` and `:165-168`):

```python
# Local SQLite file for push subscriptions + daily water usage only (see storage.py).
# Reading history is NOT stored here -- it lives in the in-memory buffer and Google Sheets.
# Set "historyDbFile" to "" to disable it (push subscriptions won't survive a restart and
# daily usage won't persist, but everything else keeps working).
HISTORY_DB_PATH = webconfig.get("historyDbFile", "history.db")
```

and, further down:

```python
if HISTORY_DB_PATH and storage.init(HISTORY_DB_PATH):
    print(f"✅ Local database at {HISTORY_DB_PATH} (push subscriptions + daily water usage).")
else:
    print("⚠️ Local database disabled; push subscriptions and daily water usage won't persist.")
```

Replace the first block with:

```python
# Turso (libSQL) database for push subscriptions + daily water usage + AI reports only (see
# storage.py). Reading history is NOT stored here -- it lives in the in-memory buffer and
# Google Sheets. Leave "tursoDatabaseUrl" empty to disable it (push subscriptions won't
# survive a restart and daily usage/AI reports won't persist, but everything else keeps
# working). The auth token is a real secret -- read from the environment, never committed.
TURSO_DATABASE_URL = webconfig.get("tursoDatabaseUrl", "")
TURSO_AUTH_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "")
```

(Confirm `os` is already imported in `main.py` — it is, used elsewhere in the file already.)

Replace the second block with:

```python
if TURSO_DATABASE_URL and storage.init(TURSO_DATABASE_URL, TURSO_AUTH_TOKEN):
    print(f"✅ Turso database at {TURSO_DATABASE_URL} (push subscriptions + daily water usage + AI reports).")
else:
    print("⚠️ Turso database disabled; push subscriptions, daily water usage, and AI reports won't persist.")
```

Confirm no other reference to `HISTORY_DB_PATH` remains anywhere in `main.py`:

```bash
grep -n "HISTORY_DB_PATH" main.py
```

Expected: no matches.

- [ ] **Step 7: Update webconfig.json**

Open `webconfig.json`. Replace the `"historyDbFile": "history.db"` line with:

```json
  "tursoDatabaseUrl": "",
```

(Left empty — the user fills in their real Turso database URL after creating one; an empty
value means `storage.init()` is never called, matching today's behavior when local storage is
disabled.)

- [ ] **Step 8: Verify with a live Turso database if credentials are available**

If a real Turso database URL + auth token have been provided (check whether the user supplied
them in this session, or whether `TURSO_AUTH_TOKEN` is set in the environment and
`webconfig.json`'s `tursoDatabaseUrl` is non-empty):

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
.venv/Scripts/python -c "
import os
import storage

url = 'PASTE_THE_REAL_URL_HERE_OR_READ_FROM_WEBCONFIG'
token = os.getenv('TURSO_AUTH_TOKEN', '')
print('init:', storage.init(url, token))
print('enabled:', storage.enabled())

storage.upsert_push_subscription('test-endpoint', 'p256dh-val', 'auth-val', {'temperature': {'warn': False, 'danger': True}})
print('subs:', storage.get_all_push_subscriptions())
storage.delete_push_subscription('test-endpoint')
print('subs after delete:', storage.get_all_push_subscriptions())

storage.add_daily_usage('2026-01-01', 'TursoTestStation', 5.0)
print('usage:', storage.get_daily_usage('2026-01-01', 'TursoTestStation'))
storage.reset_daily_usage('2026-01-01', 'TursoTestStation')
print('usage after reset:', storage.get_daily_usage('2026-01-01', 'TursoTestStation'))

storage.save_ai_report('2026-01-01', 'TursoTestStation', 'Test report text')
print('report:', storage.get_latest_ai_report('TursoTestStation'))
"
```

Expected: no exceptions, `init: True`, `enabled: True`, subscription/usage/report values
round-trip correctly, matching what the equivalent local-SQLite version would have produced.
Clean up the test rows afterward (delete the test station's `daily_usage`/`ai_reports` rows
and the test push subscription, same courtesy as prior sessions' manual verification scripts
in this repo).

If NO real Turso credentials are available in this environment, skip live verification and
report it as unconfirmed — do not fabricate results. Static verification (the code reads
correctly, Step 1's package/API check passed, `grep -n "sqlite3" storage.py` is empty, and
`main.py`/`webconfig.json` compile/parse) is what's actually achievable without credentials.

```bash
.venv/Scripts/python -c "import py_compile; py_compile.compile('storage.py', doraise=True); py_compile.compile('main.py', doraise=True); print('both compile cleanly')"
python -c "import json; json.load(open('webconfig.json')); print('webconfig.json is valid JSON')"
```

- [ ] **Step 9: Update requirements.txt**

Remove any reference to `pyserial`-adjacent or unrelated entries — don't touch those. Just
confirm the new Turso package (from Step 1) is added:

```bash
grep -n "libsql" requirements.txt || echo "libsql==<installed-version>" >> requirements.txt
```

Replace `<installed-version>` with whatever `pip show libsql` (or the actual package name from
Step 1) reports as installed, pinned exactly like `pyserial==3.5` already is in this file.

- [ ] **Step 10: Fix CLAUDE.md's stale historyDbFile reference**

`CLAUDE.md:38` currently reads (in the `## Architecture (main.py / FastAPI path)` section's
Config bullet):

```
- **Config**: `webconfig.json` sets `staticDir` (WebGL build folder), `googleSheetsWebhookUrl`, `calibrationFile`, `historyDbFile` (local SQLite for push subscriptions + daily water usage only, **not** reading history; `""` disables it, default `history.db`), `vapidPrivateKeyFile`/`vapidPublicKey`/`vapidSubject` + `httpsCertFile`/`httpsKeyFile`/`httpsPort` (Push notifications below), and `updateApiKey` (`/update` auth, below). Missing file/keys fall back to defaults.
```

Replace `` `historyDbFile` (local SQLite for push subscriptions + daily water usage only, **not** reading history; `""` disables it, default `history.db`) `` with:

```
`tursoDatabaseUrl` (Turso/libSQL database for push subscriptions + daily water usage + AI reports only, **not** reading history; empty disables it) plus the `TURSO_AUTH_TOKEN` environment variable (the actual secret, never committed)
```

This repo's `learn-codebase`/architecture doc is read by every future contributor (human or
AI) working on this codebase — leaving it describing a removed local-SQLite config key would
compound the same kind of drift the previous sub-project's final review caught and fixed.
Search the rest of `CLAUDE.md` for any other `historyDbFile`/`history.db` reference (there may
be one more, e.g. in the "Running" section describing what `storage.py` persists) and fix
every one you find to describe the Turso-based config instead.

```bash
grep -n "historyDbFile\|history\.db" CLAUDE.md
```

Expected after your fix: no matches (or only matches that are still accurate, e.g. if
`history.db` is mentioned as a purely historical/migration note — read each remaining match
and judge whether it's now false, not just whether the string appears).

- [ ] **Step 11: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add storage.py main.py webconfig.json requirements.txt CLAUDE.md
git commit -m "Migrate storage.py from local SQLite to Turso (libSQL)"
```

---

## Self-review notes

- **Spec coverage**: connection-layer swap (Steps 2-3), `init()` signature change (Step 3),
  config surface (Steps 6-7), pragma removal (Step 3, folded into the same replacement),
  every other function body left untouched (Step 5's explicit verification), local-SQLite
  fallback deliberately NOT added (matches the "Turso everywhere" decision — no task adds one).
- **Placeholder scan**: Step 1's exact package name is genuinely undetermined until
  implementation time (external SDK naming can drift) — this is flagged as a real,
  investigate-first step with a concrete escalation path (NEEDS_CONTEXT), not a vague "TBD."
  Step 8's `PASTE_THE_REAL_URL_HERE_OR_READ_FROM_WEBCONFIG` is a placeholder the implementer
  fills from actual runtime config, not left in the committed code (Step 8 is a throwaway
  verification script, not a file that gets committed).
- **Type consistency**: `init(url: str, auth_token: str) -> bool` used consistently between
  Task 1's own Step 3 (definition) and Step 6 (call site). No other task references
  `storage.py`'s functions in this single-task plan.
