# Plan: Dashboard & Calibration Improvements

Four independent features, each executable in its own fresh chat context. Order is by
risk/size: quick wins first, the large history-window change last before verification.

**Target dashboard is `/classic` (`web/`) — the editable vanilla dashboard.** The React
SPA at `/` (`web-react/`) is a prebuilt minified bundle and is OUT OF SCOPE for edits.

---

## Phase 0: Documentation Discovery (findings — read before any phase)

### Chart.js v4 (loaded from CDN in `web/index.html`: `chart.js@4`)
Source: Chart.js official docs (context7 `/chartjs/chart.js`), verified this session.
- Multiple y-axes: bind a dataset with `yAxisID:'<id>'`, then define `scales.<id> = { type:'linear', position:'left'|'right' }`.
- Tick number formatting: `scales.<id>.ticks.callback = function(value, index, ticks){ return value + ' °C' }`.
- Tick label color (to match a line): `scales.<id>.ticks.color = '#0d9488'`.
- Horizontal gridlines: `scales.<id>.grid = { display:true, color:'#e5e7eb' }`.
- Secondary axis must set `grid.drawOnChartArea:false` so gridlines don't overlap.
- Axis border: `scales.<id>.border = { display:false }`.
- **Anti-patterns:** do NOT use Chart.js v2/v3 axis syntax (`scales: { yAxes: [...] }` arrays) — v4 uses a keyed `scales: { y: {...} }` object. Do NOT invent a `ticks.format` option; formatting is via `ticks.callback`.

### Current code locations (verified this session)
- History chart config: `web/app.js` → `ensureHistoryChart()`. Datasets: `yTemp` (left, °C),
  `yTurb` (right, ADC), `yTds` (`display:false`, hidden). This is why the graph is hard to
  read — TDS has no visible axis and gridlines are sparse.
- History fetch: `web/app.js` → `loadHistory()` calls `fetch('/history')`, refresh every 30s.
- Backend: `main.py` → `get_history()`; `HISTORY_WINDOW_SECONDS = 15*60` (**confirmed 15 min**).
- Apps Script: `google_apps_script.gs` → `doGet()` returns the **last 500 rows** (≈16 min at a
  2s cadence). This 500-row cap — not the backend filter — is what limits longer windows.
- Calibrate page: `web/calibrate.html`; live raw ADC comes from `GET /calibration` →
  `latestRaw.turbidity` (polled every 1s). Manual point capture posts to `/calibration/capture`
  with `{sensor, raw, reference, label}` (a typed `raw` is already supported).

### Google Apps Script constraints (design limits for Phase 3)
- Web app execution limit ~6 min; large `getRange().getValues()` + JSON is slow/heavy.
- 7 days at a 2s cadence ≈ 302,400 rows — **not** returnable in one call. Long windows REQUIRE
  server-side downsampling and a hard row-read ceiling (see Phase 3 risk note).
- After editing `doGet`, the web app MUST be redeployed as a **NEW version** or `/exec` keeps
  serving old code (documented gotcha in CLAUDE.md).

---

## Phase 1: Make the 15-min graph readable (y-axis numbers + gridlines)

**What to implement** (copy the multi-axis pattern from the Chart.js docs in Phase 0):
1. In `web/app.js` `ensureHistoryChart()`, keep `yTemp` (left) and `yTurb` (right), but:
   - Add `ticks.callback` to each visible axis so numbers carry units (`'24 °C'`, `'850 ADC'`).
   - Set `ticks.color` on each axis to match its line color (temp teal `#0d9488`, turbidity amber `#f59e0b`).
   - Add horizontal gridlines on the LEFT axis only: `yTemp.grid = { display:true, color:'#e5e7eb' }`;
     set `yTurb.grid.drawOnChartArea = false` (already effectively so — confirm).
2. Decide TDS: either give it a visible left/right axis too, or keep hidden but ensure the
   tooltip shows its ppm (tooltip already uses `interaction:{mode:'index'}`). Recommended: keep
   TDS hidden-axis but confirm tooltip legibility, to avoid a third crowded axis.
3. Enable the legend (`options.plugins.legend.display = true`) so each colored line is labeled.

**Doc references:** Phase 0 Chart.js snippets (`ticks.callback`, `ticks.color`, `grid`,
`drawOnChartArea:false`).

**Verification checklist:**
- [ ] Open `/classic`; the left axis shows numeric ticks WITH units; horizontal gridlines visible.
- [ ] Tick label colors visually match their line colors; legend names all three series.
- [ ] `node --check web/app.js` passes; no console errors in the browser.

**Anti-pattern guards:** no v2/v3 `yAxes` arrays; don't add a `ticks.format` key (use `callback`).

---

## Phase 2: Calibration UX — suggest min/max from live raw ADC + reset

**Goal:** While calibrating turbidity, watch the incoming raw ADC, track the min & max seen, and
let the user drop those into the two calibration point rows. Add a Reset to clear the tracked
range when readings get messy.

**What to implement** (all in `web/calibrate.html`; no backend change needed — reuse the 1s
`GET /calibration` poll that already yields `latestRaw.turbidity`):
1. In the poll/`render()` cycle, maintain client-side `obsMin`/`obsMax` of `latestRaw.turbidity`
   (ignore `null`). Mirror the client-side min/max pattern already in `web/app.js`
   `startSimulation()` (copy that structure — `Math.min`/`Math.max` accumulation).
2. Show an "observed ADC range" line in the Turbidity card: `min <obsMin> / max <obsMax>`.
3. Add two buttons: "use min as this point's ADC" / "use max as this point's ADC" that fill the
   existing `#turb-raw-in` input (the manual raw field already added this session).
4. Add a "Reset range" button (`class="danger"`) that zeroes `obsMin`/`obsMax` so a noisy dip
   can be restarted. This is display-only state; it does NOT touch captured points.
5. Guidance text: because higher ADC = clearer water, max-ADC pairs with low NTU (clean) and
   min-ADC with high NTU (turbid).

**Doc references:** existing min/max accumulation in `web/app.js` `startSimulation()` (copy
pattern); existing capture flow in `web/calibrate.html` click handler.

**Verification checklist:**
- [ ] Dip probe; the observed min/max updates live from the poll.
- [ ] "use min/max" fills `#turb-raw-in`; "Reset range" clears the observed values only (captured
      points table untouched).
- [ ] Capturing still posts `{sensor:'turbidity', raw, reference, label}` and re-fits the line.

**Anti-pattern guards:** do NOT add a new backend endpoint for this — the `/calibration` poll
already exposes `latestRaw`. Reset must not call `/calibration/reset` (that deletes saved points).

---

## Phase 3: History time-window selector (5m / 15m / 1h / 3h / 12h / 24h / 7d)

**Goal:** A dropdown on `/classic` that reloads the graph for the chosen window, reading from the
Google Sheet log. Confirm the default 15-min behavior along the way.

### 3a. Apps Script `doGet` — accept a window + downsample (`google_apps_script.gs`)
Replace the fixed last-500-rows read with a windowed, downsampled read:
- Read query params `e.parameter.seconds` (default 900) and `e.parameter.maxPoints` (default 400).
- Estimate rows to read = `ceil(seconds / 2)` (2s cadence), clamp to a `HARD_ROW_CEILING`
  (recommend 45000 ≈ 24h) and to available rows.
- Read that trailing range, filter by `timestamp >= Date.now() - seconds*1000`, then **stride-
  downsample** to ≤ `maxPoints` (`stride = ceil(filtered.length / maxPoints)`).
- Return `{ rows, seconds, stride, total }`.
- **REDEPLOY as a new version** afterward.

### 3b. Backend `/history` — parametrize the window (`main.py`)
- Accept `?window=` from a whitelist map: `{"5m":300,"15m":900,"1h":3600,"3h":10800,
  "12h":43200,"24h":86400,"7d":604800}`; default `15m`. Reject unknown values → 400.
- Append `seconds` + `maxPoints=400` to the Apps Script URL query string when fetching.
- Filter server-side to `time.time() - seconds`; return `{rows, windowSeconds}`.

### 3c. Frontend selector (`web/index.html` + `web/app.js`)
- Add a `<select id="historyWindow">` with the 7 options above (default 15m) in the "Last 15
  Minutes" card header; update the header text to reflect the selection.
- `loadHistory(window)` passes `?window=` to `/history`; call on `change` and keep the 30s
  auto-refresh for the currently-selected window.

**Verification checklist:**
- [ ] `GET /history?window=15m` returns rows all within the last 900s (confirms the 15-min default).
- [ ] Each option returns data bounded by its window; `rows.length <= maxPoints`.
- [ ] 24h returns coarser (strided) data without timing out; selector re-renders the chart.
- [ ] Backend rejects `?window=99x` with 400.

**Anti-pattern guards:** do NOT try to return every 2s row for 7d (times out / oversized). Do NOT
skip the Apps Script redeploy. Do NOT read the whole sheet with `getDataRange()` for long windows.

**⚠️ Risk / decision to surface before coding 3a:** 7 days at 2s far exceeds what one Apps Script
call can serve, so 7d will be **coarse** (strided) and, beyond `HARD_ROW_CEILING`, may not reach a
full 7 days back. Options: (A) accept coarse/partial long windows (simplest, recommended for now);
(B) log a second low-cadence "rollup" sheet for long-range history; (C) raise the ceiling
cautiously and measure execution time. Pick (A) unless the user needs true 7-day depth.

---

## Phase 4: Install a frontend-design skills plugin (user-run, terminal)

`/plugin` is NOT available in the VSCode-embedded session — it must be run in the standalone
terminal CLI (`claude`). Hand these to the user to run:
```
/plugin marketplace add https://github.com/anthropics/claude-plugins-official.git   # already added
/plugin install frontend-design@claude-plugins-official
```
(The official marketplace is already registered on this machine, so the `install` line is the
operative one.) After install, restart the CLI so the new skills load.

**Verification checklist:**
- [ ] `frontend-design` appears in `/plugin` (installed) and its skills list in a new session.

---

## Phase 5: Final Verification

- [ ] `python -c "import ast; ast.parse(open('main.py',encoding='utf-8').read())"` passes.
- [ ] `node --check web/app.js` passes.
- [ ] Grep guard: no Chart.js v2/v3 axis syntax — `grep -n "yAxes" web/app.js` returns nothing.
- [ ] Drive `/history` for every window via mocked Apps Script response (stub `urlopen`); confirm
      windowing + downsample cap, WITHOUT hitting the live sheet.
- [ ] Manual browser pass on `/classic`: readable axes (P1), window selector works (P3); on
      `/calibrate`: observed min/max + reset (P2).
- [ ] `git status` reviewed; `calibration.json`/`webconfig.json` (holds the webhook URL) not
      accidentally committed.
