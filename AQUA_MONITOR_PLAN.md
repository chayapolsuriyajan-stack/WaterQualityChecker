# New "Aqua Monitor" React Dashboard — Design & Build Plan

> Approved design/build spec for the new `/app` React dashboard. Authoritative source for the
> in-progress build. (Mirror of `~/.claude/plans/i-wanna-create-a-reactive-conway.md` so it
> travels with the repo to any device.) See `HANDOFF.md` for current build status.

## Context

The current primary dashboard at `/` is a **prebuilt Lovable bundle with no source** (`web-react/`) — we can't edit it, only reshape backend payloads to feed it. We're replacing that black box with a **new, source-controlled React SPA we fully own**: a modern, animated, fully-responsive water-quality dashboard for the Ang Kaew Reservoir / Chiang Mai University "Aqua Monitor" (ระบบตรวจวัดคุณภาพน้ำเรียลไทม์).

Decisions locked in with the user:
- **Build**: Vite + React + **TypeScript** (repo's first build step; Node 24 + npm available).
- **Component/animation libraries**: **shadcn/ui** (base primitives) · **kokonut UI** (animated cards / interactive buttons, `@kokonutui` shadcn registry) · **Bklit UI** (composable charts + ring/radial gauges + reference lines, `@bklit` registry, Visx-based) · **Motion** (motion.dev / Framer Motion v12, `motion/react`).
- **App shell**: one SPA with a **left sidebar** switching between **Dashboard (home)**, **Calibration**, and **History** tabs; a static **"Guest"** user (no auth). **Keep the app-shell + left sidebar** — required.
- **Theme freedom**: NOT bound to the old slate/cyan palette or font — free, modern design system (shadcn/kokonut defaults + a chosen accent). Layout flexible **except** the app-shell/left-sidebar stays. Bilingual (Thai primary / English secondary).
- **Fully responsive**: phone / iPad / laptop — sidebar collapses to drawer/bottom-nav, grids reflow, charts use responsive containers, touch targets ≥44px.
- **Charts show reference lines**: labeled numeric **threshold reference line(s)** on every chart/sparkline/gauge (e.g. turbidity 25 NTU, TDS 300 ppm).
- **WQI**: **frontend-derived** from live params (no backend WQI).
- **Calibration**: fully wire the **2 backend-supported sensors** (turbidity 2-point, TDS k-factor) to the existing `/calibration*` API; **Temp** read-only "factory-calibrated", **EC** read-only "derived from TDS".
- **Mount point**: served at **new route `/app`** — existing `/`, `/classic`, `/calibrate` stay untouched. Promotable to `/` later.
- **Build execution**: via the **`/claudes-plan`** pipeline (Opus 4.8 boss → parallel Sonnet 5 workers).

## Backend contract (FIXED — build against this, do not change)

- **WS `/ws/app`** pushes `{"type":"sensor_update","payload":{...}}`. Payload: `temperature`, `turbidity` (NTU or ADC per `turbidityUnit`), `turbidityRaw`, `turbidityNtu`|null, `turbidityUnit` (`"NTU"`/`"ADC"`), `tds` (ppm), `tdsVoltage`, `ec` (µS/cm), `stats` (per-key min/max). A **prime frame** on connect carries `hasData`, `lastTimestamp`, last reading. Client only receives.
- **`GET /history?window=`** (`5m/15m/1h/3h/12h/24h`, default `15m`) → `{rows:[{timestamp(ms),temperature,turbidity(raw ADC),turbidityNtu,tds,ec}],windowSeconds,source}`. Short windows = live in-memory buffer, long = Google Sheet. Selector uses `5m/15m/1h/3h/24h`.
- **`GET /calibration`** → `{mode, turbidity:{model:"linear2",points:[{raw,reference,label}],coefficients:{slope,intercept}|null,updated}, tds:{model:"kfactor",points:[{rawVoltage,reference,label,temperature}],coefficients:{k},updated}, latestRaw:{turbidity,tdsVoltage,temperature}}`.
- **Mutations**: `POST /calibration/capture {sensor,reference,label?,raw?}`, `DELETE /calibration/point {sensor,index}`, `POST /calibration/save`, `POST /calibration/reset {sensor}`, `POST /calibration/mode {enabled}`. Only `turbidity` + `tds` are calibratable. Turbidity apply = 2 captures → save → mode{enabled:true}. TDS = 1 capture (k-factor) → save.

## Key technical decisions

- **Vite `base:'/app/'`**, build to `frontend/dist/`. Dev server proxies `/ws/app` (ws:true), `/history`, `/calibration*`, `/update` → `http://localhost:8080`.
- All fetches relative; WS = `` `${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/app` `` (same-origin under `/app`, proxied in dev).
- **Routing = view state** (`useState<'dashboard'|'calibration'|'history'>`), no react-router — one static bundle, sidesteps basename issues.
- **Charts = Recharts** base for line/area + `<ReferenceLine label=...>` (the labeled numeric threshold line — hard requirement, on every chart/sparkline/gauge). Try Bklit registry first; fall back to Recharts if a primitive is missing. Radial gauges: Recharts `RadialBarChart` or small custom SVG arc + threshold marker/label.
- **Reference-line values** come from `lib/thresholds.ts` (single source). WQI chart draws lines at 50 (moderate) & 70 (good).
- **Responsive** (Tailwind): `<768px` phone — sidebar hidden → hamburger `Sheet` drawer + fixed bottom-nav, ParamGrid 1-col, right column below content. `768–1023px` tablet — collapsed/drawer sidebar, 2-col grid. `≥1024px` desktop — full sidebar + 2×2 grid + right column. `<ResponsiveContainer>`, respect `prefers-reduced-motion`.
- **Data**: TanStack Query for `/history` + `/calibration`; short windows `refetchInterval`, long one-shot. Calibration mutations **optimistic** (`onMutate` patches cache + sonner toast; `onError` rolls back).
- **`useSensorSocket`**: WS + prime handling + 30s rolling per-param sample arrays (sparklines) + `connected` + 2s **simulation fallback** (temp ~24–28°C, turbidity ~1500–1900 ADC, tds ~150–250 ppm, ec≈tds×2) + reconnect backoff.
- **`lib/wqi.ts`**: pure `wqiFromReading(...)` / `wqiFromHistoryRow(row)` → 0–100 weighted sub-index → `{score,band,color}`; same fn for live + historical so they share one source of truth. EC folded with TDS.

## Project structure

```
frontend/
  package.json vite.config.ts tailwind.config.js postcss.config.js tsconfig*.json components.json index.html
  src/
    main.tsx App.tsx index.css vite-env.d.ts
    lib/  cn.ts api.ts types.ts thresholds.ts wqi.ts useSensorSocket.ts
    components/
      shell/     Sidebar.tsx MobileNav.tsx RightContextColumn.tsx UserBadge.tsx
      dashboard/ DashboardView.tsx WqiHistoryChart.tsx WindowSelector.tsx ParamGrid.tsx ParamCard.tsx Sparkline.tsx GaugeRow.tsx RadialGauge.tsx
      calibration/ CalibrationView.tsx SensorList.tsx TwoPointForm.tsx CoefficientPreview.tsx
      history/   HistoryView.tsx HistoryTable.tsx
      ui/        # shadcn + kokonut + bklit primitives
```
`App.tsx` (Job 2) imports the three views by fixed export name: `DashboardView`, `CalibrationView`, `HistoryView`.

## The three views (all responsive)

1. **Dashboard** — top `WqiHistoryChart` (frontend WQI over `/history`, window selector `5m/15m/1h/3h/24h`, reference lines at WQI 50 & 70); center `ParamGrid` 2×2→2→1 of `ParamCard` (Temp/Turbidity/TDS/EC, live ~2s, 30s sparkline w/ threshold line, status color; turbidity honors `turbidityUnit`); bottom `GaugeRow` of 3 radial safety gauges; `RightContextColumn` (Ang Kaew metadata, GPS, station id, live network/clock).
2. **Calibration** — `SensorList` (4 sensors). Turbidity → `TwoPointForm` (Standard vs Measured) → 2× `capture`; TDS → 1-point k-factor; Temp/EC read-only. Optimistic apply (`onMutate` preview+toast; bg `capture→save→mode{enabled:true}`; rollback on error). Mode toggle + per-sensor reset.
3. **History** — `HistoryTable` from `/history?window=` (own inline selector), sortable, responsive, client-side CSV export.

## Backend changes (minimal — DONE)
- `main.py`: one `os.path.isdir`-guarded `app.mount("/app", StaticFiles(directory="frontend/dist", html=True), name="aquamonitor")`. **No** change to `/`, `/classic`, `/calibrate`, `/ws/app`, `/history`, `/calibration*`.
- `.gitignore`: `frontend/node_modules/` + `frontend/dist/`.

## Verification (end-to-end)
1. `cd frontend && npm install && npm run build` → `frontend/dist/`, no TS errors.
2. `python main.py`; open `http://localhost:8080/app` — shell + Dashboard render; `/`, `/classic`, `/calibrate` unaffected.
3. Responsive via browser at 375 / 768 / 1280 px — sidebar → drawer+bottom-nav on phone, grids reflow, no h-overflow.
4. `curl -X POST localhost:8080/update -H "Content-Type: application/json" -d '{"temperature":25,"turbidity":1700,"tdsVoltage":0.8}'` → cards/sparklines/gauges/WQI update ~2s; kill source → simulation fallback keeps UI alive.
5. Every chart/sparkline/gauge shows its labeled numeric threshold line.
6. History windows 5m→24h reload; CSV export downloads.
7. Calibration: capture turbidity 2-point + TDS point → optimistic preview + toast; `GET /calibration` reflects saved coefficients; mode toggle flips live `turbidityUnit`.

## Out of scope / future
- Storage alternative to Google Sheets (SQLite in `main.py`) for the History tab. Promote `/app`→`/` later. Auth (currently static "Guest"). pH / DO cards (no sensors yet).
