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

---

# Phase 2 — parameter detail modal, theming, i18n (built)

Added after Phase 1 shipped. Reference images: picture 1 was the feature (click a metric card to expand it); pictures 2 and 4 were **styling/colour references only**, not a feature checklist; picture 3 was the language-switcher affordance. **No backend changes** were needed.

## 1. Parameter detail modal
Clicking any of the 4 metric cards opens a dialog (`ParamDetailDialog.tsx`, over a new `ui/dialog.tsx` on the already-present `@radix-ui/react-dialog`):
- `WindowChips.tsx` — all **6** windows as pills (`5m/15m/1h/3h/12h/24h`).
- `DetailChart.tsx` — Recharts area chart with gradient fill, **numeric labels on data points** (auto-thinned so a 400-point 24h window stays readable), and labeled `ReferenceLine`s for that parameter's caution/danger cut-offs on **both** sides.
  - The Y domain is computed to keep the **nearest threshold line on each side** in view. Recharts' default data-driven domain clips a limit that sits outside the data range, which defeats the purpose of the line. Only the closest line above and below are pulled in, because forcing a far-away limit into view flattens the trend to a straight line.
- `StatTiles.tsx` — min / avg / max computed **frontend-side from the fetched window rows**. The backend's `sensor_stats` is deliberately not used: it has no `ec`, no average, and is since-server-start rather than per-window, so it would contradict the chart above it.
- `RangeWarning.tsx` — two-sided banner, distinct copy for *too high* vs *too low*.
- Info cards: **About always**; **Impact + Recommendation only when the reading is out of range**, so the modal stays compact when the water is fine.
- `ParamCard` is now a real control (`role="button"`, Enter/Space, focus-visible ring, hover lift).

## 2. Two-sided threshold bands (`lib/thresholds.ts`)
Phase 1 only had upper bounds. Added `RANGE_BANDS` + `rangeStatusFor(param, value) → { status, direction: 'high' | 'low' | 'ok' }`, plus `normalRangeText()` and `isSensorFault()`. The old `statusFor`/`colorFor`/`*_THRESHOLDS` exports still work unchanged.

| Param | Good | Caution | Danger |
|---|---|---|---|
| Temperature | 25–30 °C | outside 25–30 | < 20 or > 32 |
| TDS | 100–300 ppm | 300–500 / 50–100 | < 50 or > 500 |
| EC | 200–600 µS/cm | 600–1000 / 100–200 | < 100 or > 1000 |
| Turbidity | ≤ 25 NTU | > 25 | > 50 |

Turbidity is **upper-only**: a near-zero NTU is not a water problem, so a reading below `sensorFaultBelow` (0.2 NTU) raises a *check the sensor* note instead of a water warning. Temperature's good band moved from 20–32 to 25–30 (approved).

## 3. Internationalisation (single language, EN default)
- **`lib/strings.ts`** is the single catalogue of every user-facing string (131 keys × 2 locales, identical key sets enforced with `satisfies Record<keyof typeof en, string>`). This is the only file to edit for copy changes.
- **`lib/i18n.tsx`** — `LanguageProvider`, `useT()` (`t`, `lang`, `setLang`, `toggleLang`), plus `translateStandalone()` for `main.tsx`'s error boundary, which sits above the provider. Falls back to `en`, then to the key itself, so a missing string never renders "undefined". Persists to `localStorage` (`aqua-lang`) and syncs `<html lang>`.
- **`shell/LanguageSwitcher.tsx`** — toggles EN ⇄ ไทย. Language names are written natively in both locales.
- Phase 1's seven inconsistent bilingual patterns (`labelTh`/`labelEn` prop pairs, pre-joined `"ไทย / English"` strings, a `COPY` object, stacked spans, `·` vs `/`, English-only leftovers, mixed language order) are all gone. Every label now renders in one language.
- `lib/paramMeta.ts` holds one definition per parameter (label key, unit, precision, icon, `historyField`) so the grid and the modal stop duplicating it. Note `historyField` for turbidity is `turbidityNtu`, not `turbidity` (that column is raw ADC).
- The catalogue went through a humanizer pass: em dashes removed, ellipses normalised, hedging tightened, and several corrupted Thai strings fixed (duplicated syllables such as `ทะลุทะลุ` and `สาหร่ายสาหร่าย`, and a garbled `เมแทกอหิซม์` → `เมแทบอลิซึม`). Naming was checked against common product conventions: "Time range" rather than "History window" (Grafana/Datadog), "Sign out", "Export CSV", and `user.role` as "View only" so it stops duplicating the "Guest" name.
- **CSV export headers stay English and fixed** on purpose, so spreadsheet consumers and any downstream parsing don't break when the UI language changes. Only the button label is translated.

## 4. Theming: mint/teal, light + dark
`index.css` was recoloured to a mint/teal palette (`--primary: 162 70% 55%`) with soft radial gradient surface washes, in both light and dark. Status colours (green/amber/red) were left alone so good/caution/danger stays legible. `main.tsx` now mounts `next-themes` `ThemeProvider` (`attribute="data-theme"`, which the CSS already honoured) plus `LanguageProvider`; `shell/ThemeToggle.tsx` switches light/dark. This also fixed toast theming for free, since `ui/sonner.tsx` had always called `useTheme()` with no provider mounted.

## 5. Shell polish
Nav labels are single-language via `t()`; `NAV_ITEMS` remains the one source shared with `MobileNav`. Nav buttons gained a hover transition, a motion active-indicator, and an explicit `focus-visible` ring (previously missing). `ThemeToggle` + `LanguageSwitcher` sit beside `UserBadge`, so they appear in the mobile drawer with no extra wiring.

## Phase 2 verification (evidence)
- `npm run build` clean; 984 kB JS → **295 kB gzipped**.
- `data-theme` flips `dark` → `light` with body background actually changing `rgb(14,23,27)` → `rgb(244,250,249)`; persisted across reload. (Phase 1's lesson: assert computed styles, not just class names.)
- `<html lang>` flips `en` → `th`; nav renders `แดชบอร์ด / ปรับเทียบ / ประวัติ` with no bilingual doubling; chart reference labels translate too (`ปานกลาง (50)` / `ดี (70)`); persisted.
- Detail modal: opens from all 4 cards, focus trapped, Esc closes. TDS at 355 ppm showed `Caution 300ppm` + `Danger 500ppm`, Min 341 / Avg 352 / Max 357, the *above the safe range* warning, and all three info cards. Temperature in range showed **About only**, no warning.
- Live bands confirmed against a running backend: 27.5 °C Good, 21.1 NTU Good, 355 ppm Caution, 709 µS/cm Caution.
- 375 px: zero horizontal overflow, sidebar hidden, bottom nav + hamburger present, modal fits the viewport.
- Zero console errors or warnings across all three tabs plus modals.

## Note for local testing
On this Windows machine **NVIDIA Broadcast binds `127.0.0.1:8080`**, which beats uvicorn's `0.0.0.0:8080` for `localhost` requests and makes every route 404. Use the LAN IP (e.g. `http://192.168.68.95:8080/`) or stop that app.

---

# Phase 3 — production wiring: promote to `/`, real Sheets order, real data only (built)

Requested once the full ESP32 → backend → Google Sheets → frontend chain needed to be genuinely production-ready, not a `/app`-prefixed add-on next to legacy dashboards.

## 1. Promoted to the default page, old dashboards removed
- `vite.config.ts` `base` changed from `/app/` to `/`; rebuilt so all asset URLs are root-relative.
- `main.py`: removed the black-box React SPA (`web-react/`, its `/assets` mount, and `get_index`) and the vanilla dashboard (`web/index.html`+`app.js`+`style.css`, its `/static` mount, and `get_classic_index`/`/classic`). The now-dead `NoStoreStaticFiles` helper class went with them.
- The Vite build's `SpaStaticFiles` mount moved from an early `/app` mount to **the very last line before `if __name__ == "__main__":`**, now serving `/` — Starlette matches routes in registration order, so every explicit route (`/history`, `/calibrate`, `/calibration*`, `/ws/app`, `/update`, the `Build/` WebGL mount) registered earlier in the file still wins; the root mount only catches what nothing else matched (`/`, `/favicon.svg`, `/icons.svg`, `/assets/*.js/css` — no separate `/assets` mount needed, `StaticFiles(html=True)` serves the whole `frontend/dist/` tree from one root mount).
- `web/calibrate.html`'s "← dashboard" link updated from `/classic` to `/`. `webconfig.json`'s now-orphaned `indexFile` key removed.
- Files deleted: `web/index.html`, `web/app.js`, `web/style.css`, all of `web-react/`.

## 2. Google Sheets: newest row at the top
`google_apps_script.gs` `doPost` now `insertRowBefore(2)` instead of `appendRow` — every new reading lands right after the header, pushing older rows down, so opening the sheet by hand always shows the latest data first with no scrolling. `doGet` reads the matching **leading** slice (rows 2..N) instead of a trailing one, then reverses it back to chronological ascending order before the existing cutoff-filter/stride-downsample logic (unchanged) — `main.py`'s `/history` needed no changes, since it just consumes whatever `doGet` returns. **Requires manually redeploying the Apps Script as a new version** — this file is reference-only and doesn't run from the repo; until redeployed, the live sheet keeps its old append-at-bottom behavior (still fully correct, just not newest-first for manual viewing).

## 3. Sparklines hydrate from history on load
`useSensorSocket.ts` now fires `getHistory('5m')` on mount (alongside, not before, the WS `connect()`) and merges the result into the rolling series via a new `seriesFromHistory`/`mergeSeries` pair, de-duplicated by timestamp. Previously the per-card sparklines started empty and only filled in as live pushes arrived, so a reload showed blank charts for up to ~30s.

## 4. No more fake data on disconnect
Removed `simulatedReading()` and the entire `startSimulation`/`stopSimulation`/`simulationTimerRef` machinery from `useSensorSocket.ts`. Previously, 5s of WS silence triggered a client-side generator fabricating plausible-looking random readings every 2s (temp 24–28°C, etc.) so the UI "stayed populated" — a demo-era behavior inherited conceptually from the old vanilla dashboard's `startSimulation()`. Now, on disconnect/stale data the hook only flips `connected` to `false` (driving an "Offline" badge) and leaves `reading`/`series` exactly where they were — the last real values stay on screen, frozen, rather than being silently replaced by synthetic noise. For a monitoring system whose entire purpose is surfacing real conditions, indistinguishable fake data during a real outage was actively misleading.

## 5. Calibration observed-range (turbidity only)
`TwoPointForm.tsx` now tracks the observed min/max of the live raw ADC while turbidity's form is open (client-side, resets on unmount or the new **Reset range** button), with a **Use min**/**Use max** button next to each row's raw-ADC input — porting the old standalone `/calibrate` page's UX. **Deliberately not added to TDS**: that sensor's raw input field is documented as wanting an uncalibrated *ppm* preview value, not the raw voltage `latestRaw` carries, so reusing the same min/max buttons there would insert the wrong kind of number.

## Phase 3 verification (evidence)
- `npm run build` clean; root-relative asset paths confirmed in the built `index.html`.
- Live end-to-end: a firmware-shaped `POST /update` reached the backend (temp/NTU/TDS/EC all correctly derived), was relayed to the **actual deployed** Google Sheet (confirmed via a `/history?window=3h` round-trip showing the new reading as the sheet's most recent row), and was visible over `/ws/app` in the browser.
- `/` returns 200, `/classic` returns 404, `/calibrate`/`/calibration`/`/assets/*.js`/`/favicon.svg` all 200 through the single root mount.
- History hydration confirmed with a controlled test: fed a short burst of readings, stopped the feed entirely, reloaded, and found **5 chart points already present** within ~10s with zero live traffic possible in that window — the only source for those points is the history seed.
- Frozen-not-fake confirmed with a controlled test: after the last real POST, the displayed temperature/turbidity/TDS/EC stayed byte-for-byte identical across repeated checks while the status badge read "Offline" — no drifting numbers.
- Not independently re-verified live: the reconnect transition back to "Online" after a real gap (the underlying `ws.onmessage` handler unconditionally sets `connected=true` on any message, by inspection) — the browser automation tool in this session became unresponsive mid-check on this specific case.
