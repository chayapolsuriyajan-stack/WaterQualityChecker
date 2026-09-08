# Migrate storage.py from SQLite to Turso (libSQL) — design spec

Date: 2026-09-05
Status: approved, ready for planning
Branch: `feature/vercel-migration`

## Context

Sub-project #2 of the Vercel-migration effort (see sub-project #1's spec,
`docs/superpowers/specs/2026-09-04-remove-udp-discovery-design.md`, for the full 6-part
decomposition). `storage.py` is currently local SQLite (`history.db`) holding three tables:
`push_subscriptions`, `daily_usage`, `ai_reports`. A Vercel serverless deployment has no
persistent local filesystem, so this data needs to live in a real hosted database before
`main.py` itself can be restructured for Vercel (sub-project #5).

## Decision: Turso (libSQL), not a Postgres-family provider

Turso is SQLite-wire-compatible — the existing schema, every query's `?`-placeholder style,
and the `INSERT ... ON CONFLICT ... DO UPDATE` upsert pattern all carry over unchanged, since
it's the same SQL dialect `storage.py` already uses. A Postgres-family option (Vercel Postgres/
Neon, Supabase) would mean rewriting every query (`%s` placeholders, a different client
library, connection-pooling considerations for serverless) for no benefit this project needs.

## Decision: Turso everywhere, no local-SQLite dev fallback

One code path. Local development connects to a real (free-tier) Turso database, identical to
what production uses — the entire point of this migration is proving the Vercel path actually
works, so testing against a different backend locally would risk a false sense of readiness.

## Changes (storage.py + main.py's one call site + webconfig.json)

### 1. Connection layer

Replace `sqlite3.connect(path)` with the `libsql` Python package's `connect(database=url,
auth_token=...)` — designed as a near-drop-in replacement for `sqlite3.connect()`. Kept
**synchronous** (not the async `libsql_client` variant), so every existing
`asyncio.to_thread(storage.xxx, ...)` call site in `main.py` needs zero changes — only
`storage.init()`'s own signature changes.

**Implementation note, verify during the plan/implementation:** confirm the exact current
package name and `connect()` signature against Turso's live Python SDK docs at
implementation time (SDK naming/API shape can drift between when this spec is written and
when it's implemented — same caution this project has already applied to the Gemini API
model-name situation). If `libsql.connect()` doesn't exist under that exact name, the
fallback is `libsql-client`'s sync wrapper (`libsql_client.create_client_sync`), which may
need a thin adapter to match `sqlite3`'s cursor/`row_factory` interface exactly.

### 2. `init()`'s signature

```python
def init(url: str, auth_token: str) -> bool:
```

(was `def init(path: str) -> bool:`). Same graceful-failure contract: any exception →
`_conn = None`, `return False`, `main.py` degrades exactly as it does today for a missing
local DB file.

### 3. Config surface

- `webconfig.json`: `historyDbFile` → `tursoDatabaseUrl` (the database's `libsql://...` URL,
  not a secret — Turso database URLs are not sensitive on their own).
- New environment variable `TURSO_AUTH_TOKEN` (the actual secret) — read via `os.getenv(...)`
  in `main.py`, matching the pattern the (currently uncommitted, unrelated) Gemini-key change
  already established for env-var-based secrets. `main.py`'s call site becomes:
  ```python
  storage.init(webconfig.get("tursoDatabaseUrl", ""), os.getenv("TURSO_AUTH_TOKEN", ""))
  ```

### 4. Drop local-file-only pragmas

Remove `conn.execute("PRAGMA journal_mode=WAL")` and `conn.execute("PRAGMA
synchronous=NORMAL")` — these tune local-file durability/concurrency behavior Turso manages
server-side; against a remote connection they're at best no-ops, at worst an error depending
on the client library's pragma support.

### 5. `row_factory` adapter (verify exact need during implementation)

Current code sets `conn.row_factory = sqlite3.Row` so every function can read columns by name
(`row["total_liters"]`, etc.). If the chosen Turso client supports the identical
`row_factory` mechanism, no change needed beyond the connection type. If not, add a small
private helper that zips `cursor.description` column names with each row's values into a
dict-like object supporting the same `row["column"]` access every existing function already
uses — keeping every function body below `init()` unchanged either way.

### 6. Everything else stays identical

`_SCHEMA` (all three `CREATE TABLE IF NOT EXISTS` statements), `_migrate_daily_usage_schema`'s
rebuild logic, and every one of the 13 public functions' bodies (`upsert_push_subscription`,
`delete_push_subscription`, `get_all_push_subscriptions`, `add_daily_usage`,
`get_daily_usage`, `get_recent_daily_usage`, `reset_daily_usage`, `update_push_prefs`,
`station_has_usage`, `rename_station_usage`, `rename_ai_reports`, `save_ai_report`,
`get_latest_ai_report`) are copied verbatim — no query-syntax changes, since Turso accepts
the exact SQL already written.

## Setup requirement (human action, not something I can do)

A Turso database must exist before this can be implemented or tested. The user creates one
(via `turso db create <name>` with the Turso CLI, or their web dashboard) and provides the
resulting database URL and an auth token. Per the "Turso everywhere" decision, the same
database (or a second free-tier one) serves local dev too.

## Non-goals

- `main.py`'s per-station in-memory dicts (`history_buffer`, `calibration`, `sensor_stats`,
  etc.) — untouched, that's sub-project #3.
- No WebSocket, frontend, or Vercel-function-restructuring changes — sub-projects #4-6.
- No change to what data lives where (still just push subscriptions, daily usage, AI reports —
  reading history still isn't stored here, per this file's own existing header comment).

## Testing

No automated test suite exists in this repo. Verification is manual: with a real Turso
database connected, exercise each of the 13 public functions (a small standalone script,
mirroring the exact pattern already used to verify `storage.py`'s rename helpers in an
earlier sub-project of this session), confirming reads/writes/upserts/migrations behave
identically to the local-SQLite version's documented behavior.
