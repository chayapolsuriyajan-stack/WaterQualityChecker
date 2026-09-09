# Restructure main.py for Vercel Python function conventions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the actual Vercel deployment entrypoint/config (`api/index.py`, `vercel.json`),
and neutralize every remaining piece of `main.py` that assumes a persistent process
(UDP discovery bind, midnight-sleep AI-report scheduler, a git-ignored VAPID key file) —
without touching request-handling logic (already Vercel-shaped from sub-projects #3-4) or
breaking the existing local/Windows-service deployment target.

**Architecture:** `main.py` stays one file, one FastAPI app — no route-splitting. Two startup
behaviors (UDP discovery, the daily-report scheduler) move from deprecated
`@app.on_event("startup")` handlers into a single `lifespan` context manager, with UDP
discovery additionally gated behind a new `IS_VERCEL` env-var check. A new
`POST /ai-report/generate-all` endpoint gives Vercel Cron one URL to hit daily, reusing the
exact same `_generate_ai_report` function the local scheduler already calls. The VAPID
private key gains an env-var fallback mirroring the Gemini key's existing pattern, since
Vercel's deployment bundle won't contain the git-ignored `.pem` file.

**Tech Stack:** FastAPI (`main.py`), `contextlib.asynccontextmanager`, Vercel's Python runtime
+ `vercel.json` config, `pywebpush` (unchanged usage, just a resolved file path).

## Global Constraints

- No automated test suite exists in this repo — verification is manual: run `python main.py`
  unmodified-behavior checks, plus `IS_VERCEL=1 python main.py` to confirm the discovery skip.
- Do not touch any request-handling route logic (`/update`, `/live`, `/history`,
  `/calibration*`, `/station/rename`, `/flow/*`, `/push/*`, `/wifi/*`) — this sub-project is
  scoped to process-lifetime/startup concerns and two small additions only.
- Match the surrounding code's comment density and style in every file touched.
- **Verify Vercel's current `vercel.json` schema and Cron request-method convention against
  live documentation before finalizing Task 1/Task 2's config files** — Vercel's exact config
  schema and Python runtime conventions can drift from what's described here; this plan's
  `vercel.json` content is a best-effort draft, not a verified-current spec, same caution
  already applied earlier in this migration to Turso's SDK and Gemini's model names.

---

### Task 1: Vercel entrypoint, config, and `lifespan` migration with `IS_VERCEL` gating

**Files:**
- Create: `api/index.py`
- Create: `vercel.json`
- Modify: `main.py`

**Interfaces:**
- Produces: `IS_VERCEL: bool` (module constant), `lifespan` (async context manager passed to
  `FastAPI(lifespan=lifespan)`), `start_discovery_listener()`/`start_daily_report_scheduler()`
  (now plain async functions, no longer route decorators, called from `lifespan`)

- [ ] **Step 1: Verify Vercel's current Python runtime + `vercel.json` conventions**

Before writing `vercel.json`, fetch Vercel's current documentation for: (a) the Python
runtime's expected entrypoint shape (does an `api/index.py` exporting `app` still work as of
today, or does the current convention differ?), (b) `vercel.json`'s current schema for
declaring a static output directory alongside a Python function and routing rules, (c) the
`crons` config's exact shape and which HTTP method Vercel issues for a scheduled invocation.
Use whatever web-fetch capability is available in your environment; if none is available,
proceed with this plan's draft below but flag this explicitly in your report as unverified.

- [ ] **Step 2: Create `api/index.py`**

```python
# Vercel's Python runtime imports this module and looks for an ASGI-compatible `app`
# attribute -- main.py's existing FastAPI app is used completely unchanged; this file exists
# only because Vercel's convention expects an entrypoint under api/.
from main import app  # noqa: F401
```

- [ ] **Step 3: Create `vercel.json`**

Adjust this draft against whatever Step 1's verification found. The intent: `frontend/dist`
serves as static output (built via `cd frontend && npm run build` before deploy — this
plan doesn't add a build-command config, since Vercel's default Python+static project
detection may already handle it; verify and adjust if not), every other path routes to
`api/index.py`, and a daily cron hits the new `/ai-report/generate-all` endpoint (Task 2):

```json
{
  "outputDirectory": "frontend/dist",
  "rewrites": [
    { "source": "/(update|live|history|calibration.*|station.*|ai-report.*|push.*|flow.*|wifi.*)", "destination": "/api/index" }
  ],
  "crons": [
    { "path": "/ai-report/generate-all", "schedule": "0 0 * * *" }
  ]
}
```

(`"0 0 * * *"` is UTC midnight, not local midnight — note in a code comment on the endpoint
itself, and in this file, that this differs from the local scheduler's true local-midnight
timing; an exact-UTC-offset schedule can be tuned once the target region is known, out of
scope for this plan to guess.)

- [ ] **Step 4: Add `IS_VERCEL` and the `lifespan` context manager to `main.py`**

Add near the top of `main.py`, after the existing `import` block (add `from contextlib import
asynccontextmanager` to the imports) and before `app = FastAPI()`:

```python
# Vercel sets this automatically in every deployment (build and runtime) -- see
# https://vercel.com/docs/environment-variables/system-environment-variables. Used to skip
# startup behavior that only makes sense for a persistent local/Windows-service process.
IS_VERCEL = bool(os.getenv("VERCEL"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # start_discovery_listener/start_daily_report_scheduler are defined further down this
    # file (after DiscoveryProtocol/_daily_report_scheduler exist) -- fine, since this body
    # only runs once uvicorn actually starts serving requests, well after the whole module
    # has finished loading. Each is internally guarded by its own _started flag because the
    # local dual-HTTP+HTTPS deployment (see __main__ below) runs two separate uvicorn.Server
    # instances against this SAME app object, and each one drives the ASGI lifespan protocol
    # independently -- without the guards, an HTTPS-enabled local deployment would try to
    # bind the UDP discovery socket twice and start two competing midnight-report loops.
    await start_discovery_listener()
    await start_daily_report_scheduler()
    yield


app = FastAPI(lifespan=lifespan)
```

Replace the existing `app = FastAPI()` line (currently line 30) with the block above.

- [ ] **Step 5: Convert the two `@app.on_event("startup")` handlers to plain functions, add the `IS_VERCEL` gate**

Replace:

```python
_discovery_listener_started = False

@app.on_event("startup")
async def start_discovery_listener():
    # Running HTTP:8080 and HTTPS:8443 as two separate uvicorn Server instances against the
    # same app (see __main__ below) means this startup event fires once per server -- guard
    # so the UDP socket, a single process-wide resource, is only bound once. Without this the
    # second server's bind attempt raises OSError (WinError 10048) and startup fails entirely.
    global _discovery_listener_started
    if _discovery_listener_started:
        return
    _discovery_listener_started = True
    loop = asyncio.get_event_loop()
    await loop.create_datagram_endpoint(
        DiscoveryProtocol,
        local_addr=("0.0.0.0", DISCOVERY_PORT),
    )
    print(f"📡 UDP discovery listener active on port {DISCOVERY_PORT} (firmware IP auto-discovery)")


@app.on_event("startup")
async def start_daily_report_scheduler():
    # Same double-startup-event concern as start_discovery_listener above (HTTP:8080 and
    # HTTPS:8443 are two uvicorn Server instances sharing one app, so "startup" fires
    # twice) -- guard so only one _daily_report_scheduler loop ever runs, not two racing to
    # generate/overwrite the same day's report.
    global _daily_scheduler_started
    if _daily_scheduler_started:
        return
    _daily_scheduler_started = True
    asyncio.create_task(_daily_report_scheduler())
```

with:

```python
_discovery_listener_started = False

async def start_discovery_listener():
    # Called from lifespan() (see above), not a route decorator any more -- FastAPI's
    # @app.on_event is deprecated. Skipped entirely on Vercel: a serverless container has no
    # LAN to discover firmware on, and binding an ephemeral UDP port on every cold start is
    # pure waste even if the bind itself doesn't outright fail in that sandboxed environment.
    if IS_VERCEL:
        return
    # Called once per uvicorn.Server instance sharing this app (see lifespan()'s docstring
    # comment) -- guard so the UDP socket, a single process-wide resource, is only bound
    # once. Without this a local HTTPS-enabled deployment's second server would raise
    # OSError (WinError 10048) on its bind attempt and fail startup entirely.
    global _discovery_listener_started
    if _discovery_listener_started:
        return
    _discovery_listener_started = True
    loop = asyncio.get_event_loop()
    await loop.create_datagram_endpoint(
        DiscoveryProtocol,
        local_addr=("0.0.0.0", DISCOVERY_PORT),
    )
    print(f"📡 UDP discovery listener active on port {DISCOVERY_PORT} (firmware IP auto-discovery)")


async def start_daily_report_scheduler():
    # Called from lifespan(), not a route decorator any more. Skipped on Vercel -- an
    # in-process loop that sleeps until local midnight is meaningless in a serverless
    # container that can be recycled anytime; Vercel Cron (see /ai-report/generate-all)
    # replaces it there instead.
    if IS_VERCEL:
        return
    # Same double-lifespan-invocation concern as start_discovery_listener above.
    global _daily_scheduler_started
    if _daily_scheduler_started:
        return
    _daily_scheduler_started = True
    asyncio.create_task(_daily_report_scheduler())
```

- [ ] **Step 6: Verify**

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import ast; ast.parse(open('main.py', encoding='utf-8').read())"` — expect no output.

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import main"` from the repo root — expect the normal startup banner (now including the UDP discovery line, since `IS_VERCEL` is unset locally), no traceback.

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import os; os.environ['VERCEL']='1'; import main"` — expect the SAME startup banner MINUS the "📡 UDP discovery listener active" line, confirming the gate works.

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import json; json.load(open('vercel.json'))"` — expect no output (confirms `vercel.json` is at least valid JSON).

- [ ] **Step 7: Commit**

```bash
git add api/index.py vercel.json main.py
git commit -m "Add Vercel entrypoint/config, migrate startup events to lifespan with IS_VERCEL gating"
```

---

### Task 2: `/ai-report/generate-all` endpoint, VAPID env-var fallback, docs

**Files:**
- Modify: `main.py`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1's `IS_VERCEL`
- Produces: `POST /ai-report/generate-all` (Vercel Cron's target), `VAPID_PRIVATE_KEY_PATH`
  (module constant, resolved once at import time)

- [ ] **Step 1: Add `POST /ai-report/generate-all`**

Add near the existing `POST /ai-report/generate` route:

```python
@app.post("/ai-report/generate-all")
async def generate_ai_reports_all():
    """Vercel Cron's target (see vercel.json's "crons" entry) -- generates (or, within
    cooldown, returns the cached) AI daily report for every station that currently has data,
    the same loop _daily_report_scheduler's local-deployment midnight path already runs.
    Cron hits one URL on a schedule; this fans that single trigger out across every known
    station. Not backend-auth-gated, same precedent as the per-station POST
    /ai-report/generate -- every call is already cooldown-protected
    (AI_REPORT_COOLDOWN_SECONDS), so an internet-reachable trigger can't burn through the
    Gemini quota any faster than the existing manual button already couldn't."""
    stations = await asyncio.to_thread(storage.list_stations) if storage.enabled() else []
    results = {}
    for station in stations:
        text, cached = await _generate_ai_report(station)
        results[station] = {"generated": text is not None, "cached": cached}
    return JSONResponse({"stations": results})
```

- [ ] **Step 2: Add the VAPID env-var fallback**

Add `import tempfile` to the top-of-file import block.

Replace the existing:

```python
VAPID_PRIVATE_KEY_FILE = webconfig.get("vapidPrivateKeyFile", "vapid_private_key.pem")
```

context (leave this line as-is) — add immediately after it (and after `VAPID_PUBLIC_KEY`/
`VAPID_CLAIM_SUB`, wherever fits without splitting the existing related lines):

```python
def _resolve_vapid_key_path() -> str:
    """Returns a usable file path for the VAPID private key. If VAPID_PRIVATE_KEY_FILE
    already exists on disk (the local-deployment case -- a git-ignored file generated once
    per machine via `vapid --gen`), use it as-is. Otherwise, fall back to a
    VAPID_PRIVATE_KEY environment variable holding the raw PEM text and materialize it to
    /tmp (the one writable path in Vercel's otherwise read-only deployment filesystem) once
    at import time -- mirrors _load_gemini_api_key's existing file-then-env-var pattern."""
    if os.path.exists(VAPID_PRIVATE_KEY_FILE):
        return VAPID_PRIVATE_KEY_FILE
    key_text = os.getenv("VAPID_PRIVATE_KEY", "")
    if not key_text:
        return VAPID_PRIVATE_KEY_FILE  # unchanged not-found path; vapid_available() stays False
    tmp_path = os.path.join(tempfile.gettempdir(), "vapid_private_key.pem")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(key_text)
    return tmp_path


VAPID_PRIVATE_KEY_PATH = _resolve_vapid_key_path()
```

Replace:

```python
def vapid_available() -> bool:
    return os.path.exists(VAPID_PRIVATE_KEY_FILE) and bool(VAPID_PUBLIC_KEY)
```

with:

```python
def vapid_available() -> bool:
    return os.path.exists(VAPID_PRIVATE_KEY_PATH) and bool(VAPID_PUBLIC_KEY)
```

Replace both `webpush(...)` call sites' `vapid_private_key=VAPID_PRIVATE_KEY_FILE` argument
with `vapid_private_key=VAPID_PRIVATE_KEY_PATH` (one in `_send_one_push`, one in the
`/push/test` handler — grep for `VAPID_PRIVATE_KEY_FILE` to find both after this edit; only
the `webconfig.get("vapidPrivateKeyFile", ...)` line itself should still reference
`VAPID_PRIVATE_KEY_FILE`, every other usage switches to `VAPID_PRIVATE_KEY_PATH`).

- [ ] **Step 3: Update CLAUDE.md**

- Add a line to the "Push notifications" section noting the VAPID private key now also
  accepts a `VAPID_PRIVATE_KEY` environment variable (raw PEM text) as a Vercel-compatible
  fallback when the git-ignored `vapid_private_key.pem` file isn't present in the deployment
  bundle, materialized to `/tmp` at import time — same pattern as the Gemini API key file.
- Add a new subsection (or extend "AI daily report (Gemini)") describing
  `POST /ai-report/generate-all` and its Vercel Cron trigger, alongside the existing local
  midnight-scheduler description — note both call the same `_generate_ai_report` function.
- Add a brief "Vercel deployment" note (new section, or extend an existing one) describing:
  `api/index.py` + `vercel.json` as the entrypoint, `frontend/dist` served as static output
  by Vercel directly (not through the Python function), `IS_VERCEL` gating UDP discovery and
  the in-process daily scheduler, and which environment variables a Vercel deployment needs
  set (`TURSO_AUTH_TOKEN`, `GEMINI_API_KEY` or a committed key file, `VAPID_PRIVATE_KEY`,
  `UPDATE_API_KEY` if used) — cross-reference `webconfig.json`'s existing non-secret config
  values, which stay as they are (committed, read normally).

- [ ] **Step 4: Verify**

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import ast; ast.parse(open('main.py', encoding='utf-8').read())"` — expect no output.

Run: `C:\Users\Ace\Documents\projects\WaterQualityChecker\.venv\Scripts\python.exe -c "import main"` — expect a clean startup banner.

Write and run a standalone `starlette.testclient.TestClient` script (scratchpad, delete
after) against a local file-backed Turso database with 2+ stations seeded via `/update`,
confirming `POST /ai-report/generate-all` returns `{"stations": {...one entry per seeded
station...}}` — if `gemini_available()` is false in this environment (no real API key),
confirm each station's entry still comes back well-formed (e.g. `{"generated": false,
"cached": false}` from `_generate_ai_report`'s early `return None, False` when
`gemini_available()` is false) rather than the endpoint erroring.

Write and run a second small script confirming `_resolve_vapid_key_path()`'s env-var
fallback: with no `vapid_private_key.pem` on disk and `VAPID_PRIVATE_KEY` set to some dummy
PEM-shaped text, confirm the function returns a path under the system temp directory whose
contents match the env var, and confirm `vapid_available()` reflects the resolved path
correctly (True/False based on `VAPID_PUBLIC_KEY` also being set, matching its existing
logic).

- [ ] **Step 5: Commit**

```bash
git add main.py CLAUDE.md
git commit -m "Add POST /ai-report/generate-all for Vercel Cron, VAPID env-var fallback"
```
