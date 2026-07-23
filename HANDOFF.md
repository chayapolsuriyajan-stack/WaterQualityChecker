# HANDOFF — Aqua Monitor `/app` dashboard build (in progress)

**Date:** 2026-07-23 · **Branch:** `feat/aqua-monitor-dashboard` · **Repo:** github.com/chayapolsuriyajan-stack/WaterQualityChecker

This is a mid-build checkpoint (committed because a usage limit was near). The new `/app` React dashboard is **partially built**. Full design spec: **`AQUA_MONITOR_PLAN.md`**. Build is driven by the **`/claudes-plan`** skill (shipped in this repo at `.claude/skills/claudes-plan/SKILL.md`).

---

## Quick resume (other device or after limit reset)

1. `git fetch && git checkout feat/aqua-monitor-dashboard`
2. `cd frontend && npm install`  (node_modules is git-ignored)
3. Resume the build — re-run the pipeline:
   `/claudes_plan finish the Aqua Monitor /app build per AQUA_MONITOR_PLAN.md and HANDOFF.md — Job 6 + backend done, Job 1 partial, Jobs 2-5 not started` (switch to Opus 4.8 first: `/model claude-opus-4-8`).
4. When code lands: `cd frontend && npm run build`, then `python main.py` (Windows: needs UTF-8; already handled in main.py) and open `http://localhost:8080/app`.

Backend already serves `/app` from `frontend/dist` (built output). Until `npm run build` runs, `/app` 404s by design.

---

## Status

### DONE
- **Planning**: `AQUA_MONITOR_PLAN.md` approved (design + fixed backend contract). Boss produced the 6-job split (below).
- **Job 6 — backend mount + gitignore** ✅: `main.py` has the `os.path.isdir`-guarded `app.mount("/app", StaticFiles(directory="frontend/dist", html=True), name="aquamonitor")` (~line 96); `.gitignore` has `frontend/node_modules/` + `frontend/dist/`. No existing routes touched.
- **Job 1 — scaffold (PARTIAL)**: `frontend/` Vite+React+TS+Tailwind scaffold present; `package.json` has all deps (react, motion, recharts, @tanstack/react-query, sonner, class-variance-authority, clsx, tailwind-merge, lucide-react, radix primitives; dev: vite, typescript, tailwind, @vitejs/plugin-react, oxlint). `node_modules` installed. Present: `src/main.tsx`, `src/index.css`, `src/lib/cn.ts`, `src/vite-env.d.ts`, and **14 shadcn UI primitives** now correctly at `src/components/ui/*` (badge, button, card, dropdown-menu, input, label, select, separator, sheet, skeleton, sonner, table, tabs, tooltip). Note: the `@`-alias Windows bug that dumped these into `frontend/@/` was fixed (moved to `src/components/ui/`).

### LEFT
- **Job 1 finish**: create `src/lib/api.ts`, `src/lib/types.ts`, `src/lib/thresholds.ts`, `src/lib/wqi.ts`, `src/lib/useSensorSocket.ts` (specs in AQUA_MONITOR_PLAN.md "Key technical decisions"). Verify UI components' `cn` import path — they may import `@/lib/utils`; this project uses `src/lib/cn.ts`, so either add a `lib/utils.ts` re-export or fix imports. Optionally attempt `npx shadcn add @kokonutui/... @bklit/...` (animated card/button, chart, ring gauge); fall back to Recharts if unavailable.
- **Job 2 — app shell** (`src/App.tsx` + `src/components/shell/`: Sidebar, MobileNav, RightContextColumn, UserBadge). `main.tsx` already imports `./App` which does NOT exist yet — this is why a full build currently fails. Responsive sidebar → drawer/bottom-nav.
- **Job 3 — dashboard** (`src/components/dashboard/`: DashboardView, WqiHistoryChart, WindowSelector, ParamGrid, ParamCard, Sparkline, GaugeRow, RadialGauge). Reference lines required.
- **Job 4 — calibration** (`src/components/calibration/`: CalibrationView, SensorList, TwoPointForm, CoefficientPreview). Optimistic mutations to `/calibration*`.
- **Job 5 — history** (`src/components/history/`: HistoryView, HistoryTable + CSV export).
- Then `npm run build` + run the verification checklist in AQUA_MONITOR_PLAN.md.

**Dependency order:** Job 1 must be complete before Jobs 2–5 (they import `@/lib/*` and `@/components/ui/*`). Jobs 2–5 are file-disjoint and parallelizable. Job 6 is done.

---

## The 6-job split (from the Opus Boss — verbatim scope)

- **Job 1 (foundation, first):** owns all of `frontend/` config + `src/main.tsx` + `src/index.css` + `src/lib/**` + `src/components/ui/**`. Scaffold, deps, shadcn primitives, thresholds/wqi/useSensorSocket/api libs.
- **Job 2 (after 1):** `src/App.tsx` + `src/components/shell/**` — AppShell, sidebar, responsive nav, RightContextColumn; imports the 3 views by fixed export name (`DashboardView`/`CalibrationView`/`HistoryView`).
- **Job 3 (after 1):** `src/components/dashboard/**` — WQI chart + 2×2 param grid + sparklines + 3 radial gauges, all with labeled reference lines.
- **Job 4 (after 1):** `src/components/calibration/**` — 4-sensor list, two-point/k-factor forms, optimistic apply + toast, mode toggle.
- **Job 5 (after 1):** `src/components/history/**` — `/history` table + sort + CSV export.
- **Job 6 (independent, DONE):** `main.py` `/app` mount + `.gitignore` frontend entries.

---

## Other important context (from this session, already on `main`)
- Backend `main.py` recently gained: backend-owned sensor calibration (turbidity 2-pt, TDS k-factor) + `/calibration*` API + `/calibrate` page (`web/calibrate.html`); `ec` derivation; windowed `/history?window=` (5m–24h, live buffer + Google Sheet); UTF-8 stdout fix for Windows.
- **Google Sheets** logging works (verified); the user is considering replacing it with SQLite later to "avoid heavy things" — noted as future in AQUA_MONITOR_PLAN.md.
- Two other dashboards exist and MUST keep working: `/` (black-box Lovable React SPA, `web-react/`, no source) and `/classic` (`web/`, editable vanilla). The new `/app` is additive.
- Tooling installed this session (git-ignored, not shipped): `graphify` (knowledge graph in `graphify-out/`), `markitdown` (doc→markdown; skill at `.claude/skills/markitdown/`).
- Run Python on Windows with `py` (Python 3.11). Node 24 + npm 11 available.

## Skills shipped in this repo (`.claude/skills/`)
- `claudes-plan/` — the Opus-boss/Sonnet-worker build pipeline (use `/claudes_plan <prompt>`).
- `firmware-contract-check/` — guards the ESP32↔backend JSON contract.
- `markitdown/` — document→Markdown conversion.
