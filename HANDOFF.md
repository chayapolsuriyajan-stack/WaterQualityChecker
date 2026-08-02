# HANDOFF — Aqua Monitor dashboard

**Updated:** 2026-07-26 · **Branch:** `feat/aqua-monitor-dashboard` · **Repo:** github.com/chayapolsuriyajan-stack/WaterQualityChecker

**Status: PHASE 1 + 2 + 3 COMPLETE and verified.** Design spec: **`AQUA_MONITOR_PLAN.md`** (Phase 2 = detail modal/theming/i18n, Phase 3 = production wiring). All three phases built with the **`/claudes-plan`** pipeline (skill shipped at `.claude/skills/claudes-plan/SKILL.md`).

**Phase 3 (latest) — production wiring:** the app is now promoted to **`/`** (no more `/app` prefix); the old black-box React SPA and the vanilla `/classic` dashboard are **deleted**, not just superseded. Google Sheets now inserts new rows at the top (needs a manual redeploy — see below). Sparklines hydrate from `/history` on page load instead of starting blank. The client-side fake-data fallback that used to kick in after 5s of silence is **removed** — on disconnect the UI now freezes the last real reading and shows "Offline", never synthetic numbers. Calibration's turbidity form got the old standalone page's observed min/max/reset UX back.

> **Local testing gotcha:** on this Windows box **NVIDIA Broadcast binds `127.0.0.1:8080`** and wins over uvicorn's `0.0.0.0:8080`, so every `localhost` route 404s even though the server is fine. Use the LAN IP (e.g. `http://192.168.68.95:8080/`) or quit that app.

---

## Quick start (other device / after a break)

```bash
git fetch && git checkout feat/aqua-monitor-dashboard
cd frontend && npm install && npm run build   # node_modules + dist are git-ignored
cd .. && python main.py                        # UTF-8 handled in main.py
```
Open **http://localhost:8080/** — this is now the only dashboard. `frontend/dist` must be built or `/` 404s by design (the mount is `os.path.isdir`-guarded).

**Google Sheets**: if you haven't already, paste the updated `google_apps_script.gs` into the spreadsheet's Apps Script editor and **redeploy as a new version** — the currently-live deployment still appends at the bottom (harmless, just not newest-first for manual viewing) until you do.

Dev loop with HMR: `cd frontend && npm run dev` (Vite proxies `/ws/app`, `/history`, `/calibration*`, `/update` → :8080, so run `python main.py` alongside).

---

## What was built

**`/`** — a source-controlled Vite + React 19 + TS + Tailwind v4 SPA, now the **only** dashboard (promoted from `/app` in Phase 3; the old black-box SPA and `/classic` are deleted). Left sidebar (required) with **Dashboard / Calibration / History** tabs + static "Guest" badge. `/calibrate` (the standalone vanilla calibration page) is the one other surviving route, kept deliberately alongside the app's own Calibration tab.

- **Dashboard** — frontend-derived WQI area chart with labeled reference lines (Moderate 50 / Good 70) and a 5m/15m/1h/3h/**12h**/24h time-range selector reading `GET /history?window=`; 2×2 live param grid (Temp / Turbidity / TDS / EC) over `WS /ws/app` (~2s) with 30s sparklines, each carrying its own numeric threshold line; 3 radial safety gauges; right context column (Ang Kaew metadata, station AK-001, GPS, live WS status + clock). **Every card is clickable** and opens the Phase 2 detail modal.
- **Calibration** — turbidity 2-point + TDS k-factor wired to the real `/calibration*` API with optimistic apply (instant preview + toast, background `capture → save → mode`, rollback on error), mode toggle, per-sensor reset, point delete. Temperature ("factory-calibrated") and EC ("derived from TDS") are read-only, matching what the backend can actually calibrate.
- **History** — `/history` table, sortable, null-safe, client-side CSV export.
- **Responsive** — ≥1024px full 256px sidebar + right column; 768–1023px 72px icon rail + 2-col grid; <768px hamburger `Sheet` drawer + fixed bottom nav + 1-col grid. No horizontal overflow at any of 375 / 768 / 1280.
- **Backend delta** (Phase 1: tiny; Phase 3 restructured the mounts, no sensor/route *logic* changed): a guarded `SpaStaticFiles` mount (`no-store` on the HTML shell, `immutable` on hashed assets) + `GZipMiddleware`, now serving `frontend/dist` at root `/` as the very last route registered (catches only what no explicit API route already matched). The old `web-react`/`web` mounts and their `/classic`/`get_index` handlers are gone along with the files they served.

## Verified (evidence, not assumption)
- `npm run build` clean; 950 kB JS → **286 kB gzipped** over the wire (gzip confirmed via `content-encoding: gzip`).
- Theme: built CSS contains `.bg-card` / `.text-primary` / `.border-border` etc. (were **0** before the P0 fix); computed styles resolve real colors (card `rgb(19,22,32)` vs body `rgb(12,15,23)`, border `rgb(37,42,55)`).
- All 3 tabs switch; sparkline history survives tab round-trips (single shared socket); **zero console errors**.
- Live: with readings flowing, turbidity shows **24.1 NTU** calibrated; with calibration mode **OFF** it correctly shows raw ADC + "uncalibrated" and a muted badge (no bogus red "Danger").
- Routes still 200 (Phase 1/2, historical — `/classic`/`/app` no longer exist post-Phase 3, see below): `/`, `/classic`, `/calibrate`, `/calibration`, `/history?window=5m`, `/history?window=24h`, `/app/`.

## Notable bugs found and fixed during verification
1. **Tailwind v4 didn't load `tailwind.config.js`** → the entire semantic color system compiled to nothing. Ported to `@theme` in `index.css`. *(Caught by the Opus review, not by my own layout-focused checks — a genuine blind spot: measuring computed widths passes while colors are dead.)*
2. **`AnimatePresence mode="wait"` deadlocks on React 19 + motion 12** — the exiting child never resolved, so tab/panel switches never mounted the new view. Replaced with a keyed `motion.div`.
3. **WQI fed raw ADC into the NTU sub-index** when uncalibrated, capping the score ~65 so the chart could never reach its own "Good (70)" line.
4. **Prime WS frame fabricated zeros** (`hasData:false` → 0.0 °C / 0 ppm badged green) because the guard branch was unreachable.
5. **Two `/ws/app` sockets** were open; hoisted into a `SensorProvider`.
6. **Stale `/app` shell** served a deleted bundle hash after each rebuild → `SpaStaticFiles`. Windows path separators made a naive `/assets/` check silently never match.

## Known limitations / next steps
- **Editing UI copy**: change `frontend/src/lib/strings.ts` only. Both locales must keep identical key sets (the `satisfies` clause enforces it at build time). **CSV export headers are intentionally English and fixed** so spreadsheet consumers don't break when the UI language changes.
- **kokonut UI / Bklit UI registries were not used** — components are shadcn/ui + Recharts + Motion. The plan explicitly permitted this fallback, but if you specifically want those libraries' visuals, that's outstanding work.
- **Single ~950 kB chunk** (286 kB gzipped, acceptable). Code-splitting recharts/motion via `manualChunks` is the easy win if you want it smaller.
- **No screenshots in `docs/`** for the new app — the Playwright CLI wouldn't install a browser in this environment; verification was done via DOM + computed styles instead.
- **pH / dissolved oxygen** have no sensors, so they're absent (the old black-box SPA showed placeholders).
- **Google Sheets → SQLite** migration for history still open (your "avoid heavy things" idea); `/history` long windows currently round-trip to Apps Script.
- Auth is a static "Guest" badge — no login.
- **Not independently re-verified live**: the WS reconnect transition back to "Online" after a real gap. The `ws.onmessage` handler unconditionally sets `connected=true` on any message (confirmed by reading the code), but the browser automation tool in the verification session became unresponsive partway through observing this specific transition live. Worth a quick manual check.
- **Google Sheets insert-at-top requires a manual redeploy** in the Apps Script editor (see Quick start above) — this repo's copy is reference-only and never runs on its own.

---

## Repo context
- Backend `main.py` (FastAPI, port 8080): sensor ingest `POST /update`, WS fan-out `/ws/app`, backend-owned calibration + `/calibration*`, windowed `/history`, UDP firmware discovery on 8888, Google Sheets relay. Run Python via `py` (3.11) on this Windows box; Node 24 + npm 11 available.
- Firmware `firmware/esp32/esp32.ino` POSTs raw `{temperature, turbidity, tdsVoltage}`; contract is **not** auto-synced with the backend — see the `firmware-contract-check` skill.
- Skills in `.claude/skills/`: `claudes-plan` (this build pipeline), `firmware-contract-check`, `markitdown`.
- `graphify-out/` holds a local knowledge graph (git-ignored); regenerate with `graphify . --update`.
