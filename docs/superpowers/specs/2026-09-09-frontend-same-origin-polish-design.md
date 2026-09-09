# Frontend same-origin polish — design spec

Date: 2026-09-09
Status: approved, ready for planning
Branch: `feature/vercel-migration`

## Context

Sub-project #6 of the Vercel migration (see sub-projects #1-5's specs for the full 6-part
decomposition). The original decomposition scoped this as "API base URL / CORS / mixed-content
HTTPS" — written before sub-project #5 decided how the backend actually deploys to Vercel.
Sub-project #5 settled on a **unified single-domain deployment**: `vercel.json` routes API
paths to `api/index.py` (the same `main.py` FastAPI app) and serves `frontend/dist` as static
output on that *same* domain. Under that topology, the frontend and backend are always
same-origin — exactly like the existing local deployment, where `main.py` itself mounts
`frontend/dist` via `StaticFiles`. There is no cross-origin request anywhere in either
deployment target this app supports.

## Decision: same-origin only, no CORS/absolute-base-URL machinery

Confirmed (this session): hosting the dashboard on Vercel while running `main.py` elsewhere
(a different domain/host) is explicitly **not** a supported topology. Building CORS headers,
an env-driven absolute API base URL, or mixed-content handling would be real, non-trivial
surface area for a deployment shape nobody is asking for. Sub-project #6 narrows to a small
verification-and-polish pass instead of a new subsystem.

## What's actually broken today, found by direct inspection

- **`frontend/vite.config.ts`'s dev-server proxy table is missing two route groups.**
  Currently proxies `/live`, `/history`, `/calibration`, `/update`, `/push`, `/flow`,
  `/wifi` to `http://localhost:8080` — but not `/ai-report` or `/station`. Under `npm run
  dev`, a request to either 404s against Vite's own server instead of reaching
  `python main.py`; both work fine in every actual deployment (local `main.py` self-serving,
  or the unified Vercel deployment), so this is a dev-only gap, not a production bug — but it
  makes `AiReportCard.tsx` and the station-rename flow silently broken in local development.
- **Every frontend `fetch()` call is already relative-path-correct.** Confirmed by grep:
  only `frontend/src/lib/api.ts` (via its shared `request()` helper) and
  `frontend/src/lib/push.ts` (inline `fetch()` calls) make network requests, and every one
  uses a bare relative path (`/live`, `/push/subscribe`, etc.) — no hardcoded host, no
  absolute URL, anywhere. No code change needed here; this is a confirmation, not a fix.

## Documentation: state the same-origin assumption explicitly

Add a short note to CLAUDE.md's Frontend section (or a new small subsection) stating plainly:
this app has exactly one supported deployment shape — frontend and backend always served
from the same origin, whether that's `main.py`'s own `StaticFiles` mount (local/Windows-
service) or Vercel's `rewrites`+static-output combination (sub-project #5). Cross-origin
hosting (frontend on one domain, backend reachable only at a different one) is explicitly
unsupported by design: no CORS middleware exists or is planned, and every frontend fetch
relies on a same-origin relative path working. This closes the ambiguity the original 6-part
plan's "#6: API base URL / CORS" wording left open, now that #5 has settled the actual
deployment shape.

## Non-goals

- CORS middleware, an absolute/configurable API base URL, or any cross-origin support —
  explicitly rejected above.
- Refactoring `push.ts` to route through `api.ts`'s shared `request()`/`ApiError` helper
  instead of its own inline `fetch()` calls — both are already correct (relative-path,
  same-origin), this would be an unrelated code-quality refactor outside this sub-project's
  actual goal (Vercel deployment compatibility), not something broken by the migration.
- Any change to `main.py`, `api/index.py`, or `vercel.json` — this sub-project is
  frontend-dev-experience and documentation only.

## Testing

No automated test suite exists in this repo. Verification is manual: run `python main.py`
and `cd frontend && npm run dev`, confirm the AI report card and station-rename flow both
work locally after the proxy fix (they currently 404 without it).
