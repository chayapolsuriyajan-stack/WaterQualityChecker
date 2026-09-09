# Restructure main.py for Vercel's Python function conventions — design spec

Date: 2026-09-09
Status: approved, ready for planning
Branch: `feature/vercel-migration`

## Context

Sub-project #5 of the Vercel migration (see sub-projects #1-4's specs for the full 6-part
decomposition). Sub-projects #1-4 already removed everything that made the backend fail
*during a request* on Vercel (UDP-broadcast-dependent firmware addressing, local SQLite,
in-memory per-station state, a persistent WebSocket). What's left is everything that assumes
a **persistent process** — code that runs once at process startup and expects to keep running
indefinitely, or that reads a file Vercel's deployment bundle won't contain. This sub-project
adds the actual Vercel entrypoint/config and neutralizes those remaining persistent-process
assumptions, without touching anything that already works correctly for the existing local/
Windows-service deployment target.

## Vercel entrypoint: one thin file, no route splitting

Add `api/index.py`:

```python
from main import app  # noqa: F401 -- Vercel's Python runtime imports this module and looks
                        # for an ASGI-compatible `app` attribute; main.py's FastAPI app is
                        # used completely unchanged.
```

Add `vercel.json` at the repo root declaring `frontend/dist` as the static build output and
routing every non-static request to `api/index.py`. `main.py` itself needs no restructuring
into multiple files — it stays one FastAPI app, matching how this codebase has always been
organized and how it's been incrementally rewritten across sub-projects #1-4.

## Static assets: Vercel's CDN serves `frontend/dist`, not the Python function

`vercel.json`'s static-output configuration serves `frontend/dist`'s built files directly —
every JS/CSS/image/font request is a CDN hit, never invoking the Python function. Only
API-shaped paths (`/update`, `/live`, `/history`, `/calibration*`, `/station/*`,
`/ai-report*`, `/push*`, `/flow/*`, `/wifi/*`) route to `api/index.py`.

`main.py`'s existing `StaticFiles` mount for `frontend/dist` (the `SpaStaticFiles` class and
its `app.mount("/", ...)` call) is **left in place, unchanged** — it's still exactly what the
local/Windows-service deployment target needs (`python main.py` serves everything itself,
there is no separate CDN in that world). On Vercel, `vercel.json`'s routing means that mount
simply never receives a request; it isn't dead code, it's dead-on-one-deployment-target code,
same posture already established for `wifi_serial.py`'s USB routes (below).

## Daily AI report: Vercel Cron replaces the in-process midnight sleep-loop

`_daily_report_scheduler`'s `while True: await asyncio.sleep(await
_seconds_until_next_midnight()); ...` assumes a process that's still running at local midnight
— meaningless under Vercel, where a function instance can be recycled at any time and has no
guarantee of being warm at any particular clock time.

Add a new endpoint:

```python
@app.post("/ai-report/generate-all")
async def generate_ai_reports_all():
    """Vercel Cron's target -- generates (or, within cooldown, returns the cached) AI daily
    report for every station that currently has data, same loop _daily_report_scheduler's
    local-deployment midnight path already runs. Cron hits one URL on a schedule; this
    fans that single trigger out across every known station. Not backend-auth-gated, same
    precedent as the per-station POST /ai-report/generate -- every call is already
    cooldown-protected (AI_REPORT_COOLDOWN_SECONDS), so an internet-reachable trigger can't
    burn through the Gemini quota any faster than the existing manual button already
    couldn't."""
    stations = await asyncio.to_thread(storage.list_stations) if storage.enabled() else []
    results = {}
    for station in stations:
        text, cached = await _generate_ai_report(station)
        results[station] = {"generated": text is not None, "cached": cached}
    return JSONResponse({"stations": results})
```

`vercel.json`'s `crons` array schedules a daily `GET`/`POST` to this path. (Vercel Cron
issues a `GET` by default; if only `POST` is registered here, either accept both methods on
this one route or check Vercel's current cron-request method at implementation time and match
it — a small detail to verify against Vercel's live docs when implementing, same "verify
against live platform docs" caution this whole migration has already applied to Turso's SDK
and Gemini's model names.)

`_daily_report_scheduler` and its `start_daily_report_scheduler` startup handler are
**unchanged** — local/Windows-service deployment keeps generating automatically at real
midnight exactly as today. Both paths (the scheduler's loop body and the new endpoint) call
the same underlying `_generate_ai_report(station)` — no duplicated report-generation logic,
just two different triggers for the same function.

## Skip local-only startup behavior when running on Vercel

Add near the top of `main.py`, alongside the other environment-derived constants:

```python
# Vercel sets this automatically in every deployment (build and runtime) -- see
# https://vercel.com/docs/environment-variables/system-environment-variables. Used to skip
# startup behavior that only makes sense for a persistent local/Windows-service process.
IS_VERCEL = bool(os.getenv("VERCEL"))
```

`start_discovery_listener` returns immediately when `IS_VERCEL` is true, before attempting to
bind the UDP socket — a serverless container has no LAN to discover firmware on, and binding
an ephemeral port on every cold start is pure waste even if it doesn't outright fail. Local
deployment (`IS_VERCEL` false) is completely unaffected.

## VAPID private key: env-var fallback, mirroring the Gemini key's existing pattern

`_load_gemini_api_key()` already falls back to `os.getenv("GEMINI_API_KEY", "")` when
`gemini_api_key.txt` doesn't exist on disk — established specifically so a git-ignored local
secret file has a Vercel-compatible equivalent. The VAPID private key (`vapid_private_key.pem`,
also git-ignored) needs the identical treatment, with one wrinkle: `pywebpush`'s `webpush()`
call expects `vapid_private_key` to be a *file path*, not raw PEM text, so an env-var-supplied
key has to be materialized to a file before use rather than passed through directly.

```python
def _resolve_vapid_key_path() -> str:
    """Returns a usable file path for VAPID_PRIVATE_KEY_FILE. If the configured file already
    exists on disk (the local-deployment case -- committed nowhere, git-ignored, present only
    on a machine that generated it), use it as-is. Otherwise, fall back to a VAPID_PRIVATE_KEY
    environment variable holding the raw PEM text, and materialize it to /tmp (the one
    writable path in Vercel's otherwise read-only deployment filesystem) once at import time."""
    if os.path.exists(VAPID_PRIVATE_KEY_FILE):
        return VAPID_PRIVATE_KEY_FILE
    key_text = os.getenv("VAPID_PRIVATE_KEY", "")
    if not key_text:
        return VAPID_PRIVATE_KEY_FILE  # unchanged not-found path; vapid_available() still False
    tmp_path = os.path.join(tempfile.gettempdir(), "vapid_private_key.pem")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(key_text)
    return tmp_path
```

`vapid_available()` and every `webpush()` call site switch from the raw
`VAPID_PRIVATE_KEY_FILE` constant to this resolved path (computed once at import time into a
new `VAPID_PRIVATE_KEY_PATH` constant, not re-resolved per request).

## Confirmed already Vercel-safe, no changes

- **`if __name__ == "__main__":`'s dual HTTP+HTTPS `uvicorn` runner** — Vercel imports
  `api/index.py` → `main.app` directly; this block never executes there. No guard needed.
- **`wifi_serial.py`'s USB-serial routes (`/wifi/*`)** — already return `{"ok": False, "error": ...}`
  when no board is found on the (nonexistent, under Vercel) serial port; the frontend already
  handles that response. No hardware ever being attached to a serverless function produces
  exactly the same "board not found" behavior these routes already handle.
- **`webconfig.json`** — committed to the repo (unlike `calibration.json`/`vapid_private_key.pem`
  before it), so it's part of every Vercel deployment bundle and reads with a plain relative
  `open()` exactly as it does locally.

## Incidental modernization: `@app.on_event("startup")` → `lifespan`

Both startup handlers are already flagged deprecated by FastAPI/Pylance. Since this
sub-project is already editing both (to add the `IS_VERCEL` gate to one of them), migrate
both to a single `lifespan` async context manager — the currently-recommended FastAPI pattern
— rather than leaving newly-touched code on a deprecated API. Purely mechanical: the two
functions' bodies move into one `lifespan(app)` generator's pre-`yield` section; no behavior
change beyond the `IS_VERCEL` gate already planned above.

## Non-goals

- Splitting `main.py` into multiple files/routers — rejected above; stays one file.
- Any change to `/live`, `/update`, `/history`, `/calibration*`, `/station/rename`, or any
  other request-handling logic — those are all already Vercel-request-shaped from
  sub-projects #3-4. This sub-project only touches process-lifetime/startup concerns.
- Frontend changes (API base URL, CORS, mixed-content HTTPS) — sub-project #6.
- Actually deploying to Vercel or provisioning real Vercel Cron/env vars — this sub-project
  writes the config and code; the user provisions the live Vercel project, its environment
  variables (`TURSO_AUTH_TOKEN`, `GEMINI_API_KEY` or the key file, `VAPID_PRIVATE_KEY`,
  `UPDATE_API_KEY` if used, `vapidPublicKey`/`vapidSubject` via `webconfig.json` as today),
  and the actual Cron schedule's enablement, same "human provisions infrastructure, this
  process writes the code that uses it" split already established for Turso in sub-project #2.

## Testing

No automated test suite exists in this repo. Verification is manual: confirm `python main.py`
still runs identically to before (proving the `IS_VERCEL`/`lifespan` changes are no-ops
locally), confirm `IS_VERCEL=1 python main.py` skips the UDP discovery bind with a log line
saying so, confirm the new `/ai-report/generate-all` endpoint works against a local Turso
database with 2+ stations seeded, and confirm `vercel.json`/`api/index.py` are at minimum
syntactically valid (`vercel dev` if the Vercel CLI is available in this environment;
otherwise a manual review against Vercel's current documented config schema, verified live
since — same caution already applied to Turso's SDK and Gemini's model name — Vercel's exact
`vercel.json` schema and Python runtime conventions can drift and should be checked against
current docs at implementation time, not assumed from training data).
