# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

HydroMonitor: a water quality monitoring system. A single ESP32 board reads DS18B20 temperature, analog turbidity, and TDS (dissolved solids) sensors and POSTs readings to a backend, which relays them to a live browser dashboard. There is no camera/image-based inference in this project (an earlier ESP32-CAM + Roboflow YOLO pipeline was removed).

There are two independent, non-interoperating backend implementations in this repo for the same job — pick one per task, don't mix them:

- **`main.py`** — FastAPI backend (the active/primary one; referenced by `webconfig.json` and the ESP32 firmware's `backendPort`). Handles HTTP sensor ingestion, WebSocket UI broadcast, and UDP-based backend discovery for the firmware.
- **`server.js`** — a minimal standalone `ws` WebSocket relay (Node). Simpler pub/sub: any client sends `IDENTIFY_WEBSITE` to register as a dashboard, and raw JSON sensor messages get broadcast to registered dashboards. Not wired to the firmware's current URL scheme (`/update` HTTP POST).

Firmware source lives in this repo at `firmware/esp32/esp32.ino` (moved here from the standalone Arduino sketches folder for consolidation). To edit/compile it in the Arduino IDE, open the `.ino` directly — the containing folder name matches the sketch name, which the IDE requires.

## Running

FastAPI backend (primary):
```
pip install -r requirements.txt
python main.py
```
Serves on `0.0.0.0:8080` with `reload=True`. Static frontend is served from `/static` (mapped to `web/`), and a WebGL build directory (default `Build/`, configurable via `webconfig.json`'s `staticDir`) is mounted at `/{staticDir}` with Brotli/gzip content-encoding support for precompressed assets.

Node relay (alternative):
```
node server.js
```
Serves on port 8080 (uses the `ws` package — no `package.json` in the repo, so install `ws` manually if using this path: `npm install ws`).

There is no test suite, linter, or build step configured in this repo.

## Architecture (main.py / FastAPI path)

- **Config**: `webconfig.json` sets `staticDir` (WebGL build output folder) and `indexFile` (dashboard HTML served at `GET /`). Missing file/keys fall back to `Build` and `index.html`.
- **Sensor ingestion** — `POST /update`: accepts either JSON body (`{temperature, turbidity, tdsVoltage}` from current firmware, or legacy `{temperature, turbidity, tds}`) or form-urlencoded body with `water_level`. Normalizes into a payload with `source`/`timestamp`, derives `ec` (electrical conductivity, µS/cm) from `tds` (`ppm_to_ec` — EC is not a separate sensor, it's the same DFRobot measurement before the standard EC→TDS ×0.5 conversion, so it always agrees with TDS), appends to the in-memory `history_buffer` for the live short-window graph, and broadcasts to all connected UI WebSocket clients as a `sensor_update` message. See Sensor calibration below for how `turbidity`/`tds` get calibrated before broadcast.
- **Dashboard fan-out** — `WS /ws/app`: browser dashboards connect here and receive `sensor_update` JSON messages. Connected clients are tracked in the `ui_clients` set guarded by `ui_clients_lock`; disconnects are pruned opportunistically during broadcast.
- **Backend discovery** — a UDP listener (`DiscoveryProtocol`, started via `@app.on_event("startup")`) binds `0.0.0.0:8888` and replies `HYDRO_HERE` to any `HYDRO_DISCOVER` packet, so firmware on the LAN can find this machine's current IP without it being hardcoded. Requires Windows Firewall to allow inbound UDP on port 8888 (added locally via `netsh advfirewall firewall add rule name="HydroMonitor UDP Discovery" dir=in action=allow protocol=UDP localport=8888` — a fresh machine won't have this rule and discovery will silently time out until it's added).

## Sensor calibration (backend-owned)

Calibration lives on the backend, not the firmware, so sensors can be recalibrated live with **no reflash**. The firmware streams raw values; `main.py` converts them using coefficients persisted in `calibration.json` (path configurable via `webconfig.json`'s `calibrationFile`, default `calibration.json`; the file is git-ignored and created on first save). Missing/invalid file → sensible defaults (turbidity uncalibrated, TDS k-factor 1.0).

- **Models**: turbidity is a **2-point linear** ADC→NTU map (`ntu = slope·adc + intercept`; slope is negative since higher ADC = clearer water; needs ≥2 captured points or it returns `None`/no NTU). TDS is the DFRobot temperature-compensated ppm polynomial (moved here from the firmware, using the live DS18B20 temp) scaled by a **single k-factor** fitted against one known-ppm solution.
- **Calibration mode gate**: saved coefficients only apply when `calibration_mode` is ON (the `/calibrate` page's on/off toggle, `POST /calibration/mode`). OFF → `/update` always emits raw ADC (`turbidityUnit: "ADC"`) and uncalibrated DFRobot ppm (k=1.0), regardless of what's saved in `calibration.json` — so a saved-but-unverified calibration can't silently affect the live dashboards until explicitly switched on.
- **`/update` output**: emits both raw and calibrated fields. `turbidity` carries **calibrated NTU** once a calibration exists, else falls back to raw ADC — the React SPA at `/` is a prebuilt bundle we can't edit and reads `turbidity` while labeling it "NTU", so this makes it display real NTU. `turbidityRaw` always carries the raw ADC (used by the calibration page and Google Sheets logging), `turbidityUnit` is `"NTU"`/`"ADC"` (the editable `/classic` dashboard reads it to label correctly), `turbidityNtu` is the calibrated NTU or `null`. TDS: `tdsVoltage` (raw) and `tds` (calibrated ppm).
- **Calibration page** — `GET /calibrate` serves `web/calibrate.html`, a self-contained page that polls `GET /calibration` ~1s for live raw values, lets you enter a known reference + capture a point (the backend averages the last ~5 raw readings to reduce noise), shows the computed coefficients, and saves.
- **REST API** (all under `/calibration*`, distinct from the `/calibrate` page): `GET /calibration` (state + `latestRaw`), `POST /calibration/mode` `{enabled}`, `POST /calibration/capture` `{sensor, reference, label?}`, `DELETE /calibration/point` `{sensor, index}`, `POST /calibration/save` (persists to `calibration.json`), `POST /calibration/reset` `{sensor}`. Captures/edits are in-memory until an explicit save.
- **Note**: Google Sheets logging is unchanged — it still logs raw ADC turbidity + (now backend-calibrated) TDS ppm. Adding NTU columns would require an Apps Script schema change.

## Google Sheets logging & history (`google_apps_script.gs`)

- Every `/update` POST that includes `temperature`+`turbidity` is relayed fire-and-forget (via `asyncio.to_thread`, so a slow/unreachable Google endpoint never blocks the ESP32's `/update` response) to a Google Apps Script Web App, configured by `webconfig.json`'s `googleSheetsWebhookUrl`. If that key is empty/missing, the relay and `/history` both no-op.
- `google_apps_script.gs` is reference-only — it does not run from this repo. Paste it into the target spreadsheet's **Extensions > Apps Script** editor and deploy as a Web App (**Execute as: Me**, **Who has access: Anyone**).
- `doPost` appends one row per reading: `Timestamp, Temperature (C), Turbidity (raw ADC), TDS (ppm)`. Turbidity is logged as the same raw averaged ADC value shown on the dashboard — the NTU conversion (`adc_to_ntu` in `main.py`) is currently bypassed pending calibration, so no calibrated NTU value reaches the sheet.
- `doGet` accepts `?seconds=` and `?maxPoints=` (default 900s / 400 points), reads a trailing slice of the sheet, filters to that window, and stride-downsamples to at most `maxPoints` so long windows stay small and fast.
- **`GET /history?window=`** — dashboard-facing endpoint in `main.py`, selectable window (`5m`/`15m`/`1h`/`3h`/`12h`/`24h`, default `15m`, `HISTORY_WINDOWS`). Short windows (`HISTORY_BUFFER_WINDOWS = {5m, 15m, 1h}`) are served **live from the in-memory `history_buffer`** — no Google Sheets round-trip, works even if the webhook is unset. Longer windows proxy `doGet` with the matching `seconds`/`maxPoints` (keeping the dashboard's fetch same-origin, avoiding browser CORS/redirect issues with Google). Every row gets `turbidityNtu` (calibrated from raw ADC via `_with_ntu`) and `ec` (from `tds` if not already present) added uniformly across both sources.
- **Redeploy gotcha**: after editing `doGet`/`doPost` in the Apps Script editor, redeploy the web app as a **new version** — otherwise `/exec` keeps serving the old code and `GET` silently returns nothing.
- Running min/max per sensor (`temperature`/`turbidity`/`tds`) is tracked separately in `main.py`'s in-memory `sensor_stats` (since server start, resets on restart, shared across all connected dashboards) — it is not persisted to or read from the spreadsheet.

## Frontend

There are **two dashboards**, both served by `main.py` (see `get_index`/`get_classic_index`):

### Primary — React SPA (`web-react/`, served at `/`)

A **prebuilt bundle with no source in this repo** — `web-react/` contains only the built output (`index.html` + `assets/*.js/css`, a TanStack Start SPA), generated externally by a Lovable project ("river-watch" / "Aqua Monitor", title "Ang Kaew Water Quality Monitor") and dropped in whole. **We cannot edit its logic or markup** — only regenerate it externally and re-drop the build. It only works served at the site root (its prerendered shell + router assume root; a subpath basepath causes hydration mismatch), which is why it's mounted at `/` rather than a subpath, with its assets at `/assets/*` (`app.mount("/assets", ...)`).
- Connects to `/ws/app` for live readings and reads `turbidity` (gets calibrated NTU once available, see Sensor calibration), `tds`, `ec`, `temperature`.
- Shows a WQI (water quality index) score with a colored radial gauge, an overall status pill, and a grid of metric cards (temperature, turbidity, TDS, EC, pH, dissolved oxygen — pH/DO have no sensor yet and show a placeholder "not yet installed" state) each with a normal-range subtitle, status badge, live value, and a small trend sparkline.
- Because it's a black box, backend response shaping exists specifically to make it display correctly without us touching its code — e.g. `turbidity` carries calibrated NTU (not raw ADC) once calibrated, since this SPA hardcodes the "NTU" label on whatever `turbidity` contains.

### Fallback — classic vanilla dashboard (`web/`, served at `/classic`)

Plain HTML/CSS/JS (no build step, no framework, fully editable) — the one to modify when a backend field needs a new visible home, since the React SPA can't be touched.

- `index.html` — dashboard shell; loads Chart.js from a CDN and `app.js`/`style.css` from `/static`.
- `app.js` — opens a WebSocket to `/ws/app` on the same host, port 8080. Expects either `{type: "sensor_update", payload: {...}}` or a flat payload and pushes points into a Chart.js line chart (temp on left axis, turbidity on right, TDS on a third hidden axis so it auto-scales without adding visual clutter). Has a **history window selector** (`HISTORY_WINDOW_LABELS`/`LIVE_HISTORY_WINDOWS`, matching the backend's `/history?window=` options) — short windows (`5m`/`15m`/`1h`) auto-refresh on an interval (`LIVE_HISTORY_WINDOWS`), longer ones are one-shot loads. Turbidity is labeled per `turbidityUnit` (NTU once calibrated, else ADC). Note: **`ec` is not wired into this dashboard yet** — it's only shown on the React SPA, even though `main.py` emits it on every reading. On disconnect, falls back to `startSimulation()`, which fabricates readings every 2s so the UI stays populated when nothing is connected.
- `index.html.bak` / `index.html.new` are stray leftover files, not referenced by any code path — check before treating either as current.

## Firmware (`firmware/esp32/esp32.ino`)

Single ESP32 dev board (not ESP32-CAM — no camera). Hardcodes Wi-Fi credentials. Not auto-synced with `main.py`; changing an endpoint contract there requires a matching firmware update.

Reads DS18B20 temperature, analog turbidity, and TDS every 2s and POSTs JSON `{temperature, turbidity, tdsVoltage}` to `http://<backendIP>:8080/update` — **all raw**: `turbidity` is the averaged raw ADC and `tdsVoltage` is the raw TDS sensor voltage. The DFRobot TDS ppm formula, its temperature compensation, and turbidity NTU conversion all now live on the **backend** (see Sensor calibration below), so the firmware no longer computes ppm — this lets sensors be recalibrated live without reflashing. (Older firmware that POSTs a pre-computed `tds` ppm still works: the backend passes it through unchanged.) The backend IP is not hardcoded: `discoverBackend()` broadcasts `HYDRO_DISCOVER` over UDP on port 8888 and takes the replying host's IP as the backend address, so it survives the backend PC's DHCP lease changing. Discovery runs once at boot (blocking retry loop) and again automatically if `/update` POSTs fail 3 times in a row (`consecutiveFailures` / `backendKnown`), so a mid-run IP change self-heals within a few broadcast cycles. Requires `main.py`'s discovery listener (see above) and a working Wi-Fi broadcast domain. Registers mDNS as `hydromonitor.local` but doesn't actually use that hostname anywhere — that's unrelated leftover, not part of backend discovery.

### Wiring

The turbidity NTU formula (`-1120.4·V² + 5742.3·V - 4353.8`) is calibrated for a 5V-powered analog turbidity sensor with a ~0–4.5V output range (DFRobot Gravity-style). ESP32 GPIOs are strictly 3.3V (not 5V-tolerant like some ESP8266 boards), so the sensor's output is scaled down through a voltage divider before reaching the ADC pin, and the firmware scales it back up (`dividerRecoveryFactor`) before applying the NTU formula.

| Sensor | Pin | ESP32 pin | Notes |
|---|---|---|---|
| DS18B20 (temp) | VCC | 3.3V | Keeps the OneWire data line's HIGH level at a safe 3.3V |
| | GND | GND | |
| | DATA | GPIO13 | Needs a 4.7kΩ pull-up to 3.3V (skip if the probe already has one). **Not GPIO12** — that's a boot-strapping pin (sets flash voltage); the required pull-up would hold it HIGH at reset and can prevent the board booting at all |
| Turbidity sensor | VCC | 5V / VIN | Needs 5V to hit its rated output curve — must be a true 5V rail |
| | GND | GND (shared) | |
| | OUT | → divider → GPIO34 | GPIO34 is ADC1 (input-only, no internal pulls); avoid ADC2 pins (0,2,12–15,25–27) since Wi-Fi disables ADC2 |
| TDS Meter V1.0 | VCC | 3.3V | Accepts 3.3–5.5V; output voltage is independent of supply choice |
| | GND | GND (shared) | |
| | A (signal) | GPIO35 (direct, no divider) | Output tops out at ~2.3V, safely under the 3.3V ADC limit. Another ADC1 pin, kept separate from GPIO34/GPIO13 |

Divider (turbidity only): R1 = 10kΩ (sensor OUT → node), R2 = 20kΩ (node → GND), node → GPIO34. Scales 0–4.5V down to 0–3.0V (safe margin under the 3.3V ADC limit); firmware multiplies by 1.5 (`dividerRecoveryFactor`) to recover the sensor's real voltage. Re-verify the NTU calibration against known reference samples once wired — the formula was tuned for the original ESP8266 read path, not this divider, and ESP32's ADC has known non-linearity near its extremes.

TDS reading uses DFRobot's official temperature-compensated formula, reusing the DS18B20's `temperatureC` (compensation coefficient `1 + 0.02·(T-25)`) rather than assuming a fixed 25°C, since the sensor's raw output drifts with water temperature.

## Knowledge graph (`graphify-out/`)

This repo has a [graphify](https://github.com/Graphify-Labs/graphify) knowledge graph built over it — `graphify-out/graph.html`/`GRAPH_REPORT.md`/`graph.json`, git-ignored, local-only. It's a queryable map of how the code, docs, and README screenshots relate (e.g. it's what surfaced that `web-react/` was undocumented here until this section was added). Regenerate after significant changes with `graphify . --update` (incremental) from the repo root; ask a question about the codebase with `graphify query "<question>"`. Most of the graph's node/edge volume comes from the vendored, minified `web-react/assets/index-*.js` bundle (TanStack Query internals) — treat any "god node" or community named after it as extraction noise, not a real architectural hotspot.
