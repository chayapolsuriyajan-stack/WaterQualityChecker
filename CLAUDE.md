# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

HydroMonitor: a water quality monitoring system. A single ESP32 board reads DS18B20 temperature, analog turbidity, TDS, and flow-sensor pulses, and POSTs readings to a backend, which relays them to a live browser dashboard and, on breaches, to subscribed browsers as OS push notifications (Push notifications below). No camera/image-based inference (an earlier ESP32-CAM + Roboflow YOLO pipeline was removed).

**`main.py`** (FastAPI) is the one and only backend — referenced by `webconfig.json` and the firmware's `backendPort`. Handles HTTP sensor ingestion, WebSocket UI broadcast, local SQLite persistence for push subscriptions + daily water usage (`storage.py`), and UDP backend discovery. (`server.js`, an earlier Node `ws` relay, no longer exists; `ws_client.py` is a standalone WebSocket test client, not a second backend.)

Firmware source lives at `firmware/esp32/esp32.ino` (moved here from the standalone Arduino sketches folder). Open the `.ino` directly in the Arduino IDE — the containing folder name matches the sketch name, which the IDE requires.

## Commands

```bash
pip install -r requirements.txt && python main.py   # backend on :8080
HYDRO_DEV=1 python main.py                          # ...with autoreload (see caveat below)

cd frontend && npm install && npm run build         # required at least once, or / 404s
cd frontend && npm run dev                          # Vite HMR, proxies API calls to :8080
cd frontend && npm run lint                         # oxlint

graphify . --update                                 # refresh the knowledge graph (see bottom)
```

**No test suite exists** on either side — there is nothing to run, and no test runner is configured. The frontend's only checks are `npm run lint` and the `tsc -b` inside `npm run build`.

## Running

Serves on `0.0.0.0:8080` (plain HTTP, always on — the ESP32 POSTs here). A second HTTPS listener on `0.0.0.0:8443` starts when `webconfig.json`'s `httpsCertFile`/`httpsKeyFile` are set (Web Push needs a secure context off `localhost` — see Push notifications below). `frontend/dist/` (see Commands) mounts at `/`. A WebGL build directory (default `Build/`, `webconfig.json`'s `staticDir`) mounts at `/{staticDir}` with Brotli/gzip content-encoding for precompressed assets — unrelated legacy Unity output.

**Autoreload is opt-in via `HYDRO_DEV=1`** (`python main.py` alone runs with `reload=False`). Don't re-enable it by default: the reloader watches the working directory, so every calibration save (`calibration.json`) and history write (`history.db`) would restart the server, dropping all dashboard WebSockets and wiping `history_buffer`/`sensor_stats`.

**Deployment**: `scripts/install-service.ps1` installs `main.py` as a Windows service via NSSM (restart-on-failure, rotated logs in `logs/`, `AppDirectory` = repo root so relative paths resolve). Run from an elevated prompt; `-Uninstall` removes it. Without it, deployment is a terminal window and a reboot silently ends monitoring.

## Architecture (main.py / FastAPI path)

- **Config**: `webconfig.json` sets `staticDir` (WebGL build folder), `googleSheetsWebhookUrl`, `calibrationFile`, `historyDbFile` (local SQLite for push subscriptions + daily water usage only, **not** reading history; `""` disables it, default `history.db`), `vapidPrivateKeyFile`/`vapidPublicKey`/`vapidSubject` + `httpsCertFile`/`httpsKeyFile`/`httpsPort` (Push notifications below), and `updateApiKey` (`/update` auth, below). Missing file/keys fall back to defaults.
- **Sensor ingestion** — `POST /update`: if `updateApiKey` is set, requires a matching `X-API-Key` header (constant-time), 401 otherwise; empty/missing (default) leaves it unauthenticated — matters once the fixed-backend-host override (WiFi provisioning below) makes it internet-reachable. Accepts JSON (`{temperature, turbidity, tdsVoltage, flowPulses, station}`, or legacy `{temperature, turbidity, tds}`) or form-urlencoded with `water_level`. `station` is optional (Multi-station support below); missing/empty normalizes to `"default"`. Normalizes into a payload, derives `ec` from `tds` (`ppm_to_ec` — same DFRobot measurement pre the EC→TDS ×0.5 conversion, so it always agrees with TDS), appends to that station's `history_buffer`, broadcasts to `/ws/app` clients as `sensor_update`. See Multi-station support, Sensor calibration, and Flow sensor below.
- **Dashboard fan-out** — `WS /ws/app`: browser dashboards connect here and receive `sensor_update` JSON messages. Connected clients are tracked in the `ui_clients` set guarded by `ui_clients_lock`; disconnects are pruned during broadcast.
- **Backend discovery** — a UDP listener (`DiscoveryProtocol`, `@app.on_event("startup")`) binds `0.0.0.0:8888`, replies `HYDRO_HERE` to `HYDRO_DISCOVER`, so LAN firmware finds this machine's IP without hardcoding. Requires a Windows Firewall inbound-UDP-8888 rule (`netsh advfirewall firewall add rule name="HydroMonitor UDP Discovery" dir=in action=allow protocol=UDP localport=8888` — a fresh machine lacks this and discovery silently times out until added). Only finds a backend on the ESP32's own subnet (UDP broadcast doesn't cross networks) — see the fixed-backend override below.

## Multi-station support (several ESP32 boards, one backend)

Several boards ("stations") at different physical locations can report to the same backend
simultaneously, each fully independent — own live readings, own history, own calibration, own
daily water-usage counter, own push-breach edge-detection. A station is identified purely by a
human-readable name string (e.g. `"Inlet"`), set once per board via USB provisioning (WiFi
provisioning above) — no separate slug/ID.

- **Backward-compat sentinel**: any reading with no `station` field (old firmware, an
  unprovisioned board) is attributed to the literal string `DEFAULT_STATION = "default"`
  everywhere — a single-board deployment behaves byte-for-byte identically to before
  multi-station support existed. `main.py`'s `_normalize_station(raw)` trims and caps at
  `MAX_STATION_NAME_LEN = 40` chars (mirrored firmware-side as `maxStationNameLen`), empty/non-string → `"default"`.
- **`/update`**: reads `station` from the JSON/form body itself (like `temperature` does, not a
  query param), included in the outgoing payload, `history_buffer` row, and Sheets `sheet_payload`.
  Every in-memory global that used to be a single value — `history_buffer`, `sensor_stats`,
  `last_severity` (breach edge-detection), `latest_raw`/`_raw_buffers` (calibration capture),
  `calibration`/`calibration_mode`, `_daily_usage_totals` — is now `dict[station] -> <value>`,
  created lazily on first use so `"default"` needs no pre-registration.
- **REST API**: a `?station=<name>` query param, defaulting server-side to `"default"`, on
  `GET /history`, every `/calibration*` endpoint, `GET /flow/usage`, `POST /flow/reset-today`.
- **`POST /station/rename`** — `{old, new}`, admin-only rename that migrates a station's identity
  across every structure in `PER_STATION_MAPS` (in-memory) plus the `daily_usage` SQLite table
  (`storage.rename_station_usage`), persists `calibration.json` immediately if the renamed
  station had calibration data, and broadcasts `{"type": "station_renamed", "old": ..., "new":
  ...}` over `/ws/app` so connected dashboards update the station's key live without waiting for
  a new reading. Does **not** touch the physical board's own provisioned name — the board will
  start a fresh station under its old name on its next reading unless separately reprovisioned
  over USB. Adding a new per-station in-memory structure? Add it to `PER_STATION_MAPS` — it's the
  single list both the rename migration and the station-existence check read from.
- **`calibration.json`** is `{"<station>": {turbidity: {...}, tds: {...}, flow: {...}}, ...}`.
  An old flat-shaped file (top-level keys are `turbidity`/`tds`/`flow` directly) migrates once on
  load: wrapped as `{"default": <old content>}`, a `.bak-premigration` backup written alongside,
  and the real file rewritten immediately in the new shape.
- **`storage.py`'s `daily_usage` table**: composite primary key `(date, station)` — migrated via
  a full table rebuild (SQLite can't `ALTER TABLE` a primary key) guarded by checking
  `PRAGMA table_info(daily_usage)` for a `station` column.
- **`WS /ws/app`**: on connect, sends one `sensor_update` prime frame per station that has data
  (each carrying its own `station` field) instead of a single merged frame; falls back to one
  `{"hasData": false}` frame only when no station has ever reported.
- **Auth stays shared**: `updateApiKey` is not per-station. **UDP discovery is unaffected**: every
  board independently discovers the same backend with zero protocol changes. **Push subscriptions**
  (`storage.py`'s `push_subscriptions`, keyed by browser endpoint) stay as-is — inherently
  per-browser-dashboard, not per-station; only the breach edge-detection (`last_severity`) is
  keyed by station.
- **Frontend**: `useSensorSocket.ts` buckets incoming readings into
  `stations: Record<string, {reading, series}>` by `SensorReading.station`; `SensorProvider.tsx`
  adds `selectedStation`/`setSelectedStation` (localStorage-persisted) and `stationNames`, plus
  `useSelectedStationData()` — a shape-compatible drop-in for the old single-station data hook,
  used by most dashboard components unchanged. `StationSwitcher.tsx` (Dashboard and History tabs)
  renders nothing for a single-station deployment (`stationNames.length <= 1`) so it never clutters
  the common case. Every history/flow-usage/calibration React Query key gained a `station` segment.
- **Google Sheets**: one sheet, one `Station` column (not one sheet per station) — see Google
  Sheets logging below.

## Sensor calibration (backend-owned)

Calibration lives on the backend, not the firmware, so sensors recalibrate live with **no reflash**. The firmware streams raw values; `main.py` converts them via coefficients in `calibration.json` (`webconfig.json`'s `calibrationFile`, default `calibration.json`, git-ignored, created on first save). Missing/invalid file → defaults (turbidity uncalibrated, TDS k-factor 1.0, flow k-factor 450.0 — YF-S201 nominal).

- **Models**: turbidity is **2-point linear** ADC→NTU (`ntu = slope·adc + intercept`; slope negative since higher ADC = clearer water; needs ≥2 points or returns `None`). TDS is the DFRobot temperature-compensated ppm polynomial (live DS18B20 temp) scaled by a **single k-factor** fitted against one known-ppm solution. Flow uses the same shape (`k` = pulses/liter, YF-S201 nominal ≈450) fitted against one known-volume pour; unlike the others it has **no good/warn/danger thresholds** — a plain quantity, absent from `thresholds.py`'s `RANGE_BANDS`/`PUSH_PARAMS`.
- **Calibration mode gate**: saved coefficients apply only when `calibration_mode` is ON (the frontend Calibration tab's toggle, `POST /calibration/mode`). OFF → `/update` always emits raw ADC (`turbidityUnit: "ADC"`) and uncalibrated ppm (k=1.0) — a saved-but-unverified calibration can't silently affect live dashboards until switched on.
- **`/update` output**: emits both raw and calibrated fields. `turbidity` carries **calibrated NTU** once a calibration exists, else falls back to raw ADC. `turbidityRaw` always carries raw ADC (Calibration tab + Sheets logging), `turbidityUnit` is `"NTU"`/`"ADC"`, `turbidityNtu` is calibrated NTU or `null`. TDS: `tdsVoltage` (raw) and `tds` (calibrated ppm).
- **REST API** (all under `/calibration*`, driving the frontend's Calibration tab — there is no separate standalone calibration page): `GET /calibration` (state + `latestRaw`, polled ~1s while the tab is open), `POST /calibration/mode` `{enabled}`, `POST /calibration/capture` `{sensor, reference, label?}` (averages the last ~5 raw readings), `DELETE /calibration/point` `{sensor, index}`, `POST /calibration/save` (persists to `calibration.json`), `POST /calibration/reset` `{sensor}`. `sensor` is `"turbidity"`, `"tds"`, or `"flow"`. Every endpoint also takes a `?station=` query param (Multi-station support above), defaulting to `"default"` — calibration is per-station. Captures/edits are in-memory until an explicit save.
- **Note**: Google Sheets logs raw ADC turbidity, backend-calibrated TDS ppm, and flow rate — not daily water usage (see Flow sensor below). Adding NTU columns would need an Apps Script schema change.

## Flow sensor (water usage & current flow)

A fifth **main** sensor (not a water-quality param — Sensor calibration above), alongside temperature/turbidity/TDS/EC. A YF-S201 hall-effect sensor on GPIO27 (digital pulse input) reports a raw pulse count each `/update`; the backend converts it via the `"flow"` k-factor into two facets:

- **Current flow rate** (`payload["flowRate"]`, L/min) — instantaneous, like the other live params (broadcast over `/ws/app`, stored in `storage.py`'s `readings.flow_rate`, no thresholds/push alerts).
- **Water usage** (`payload["waterUsageToday"]`, liters) — a **daily-resetting** counter in `storage.py`'s `daily_usage(date, station, total_liters)`, composite-keyed by local date **and station** (Multi-station support above). A day rollover starts a fresh row automatically; `POST /flow/reset-today?station=` zeroes it manually for that station. `GET /flow/usage?days=N&station=` returns today's total plus the last N days', for the "Water Usage" bar chart — separate from `/history`'s merge (different shape/cadence: one row/day, kept indefinitely).
- **Frontend**: `flow` is a `ParamKey` (ParamGrid, quick-view, Settings toggles, Calibration tab) but **absent from `RANGE_BANDS`/`ThresholdParam`** (`thresholds.ts`) — every scoring/coloring component guards against this (`ParamCard`'s optional `param` prop, `ParamDetailDialog`'s `rangeParam` narrowing). Two charts (`WaterFlowChart.tsx`, `WaterUsageChart.tsx`) sit below the ParamGrid, respecting Settings' show/hide toggles (`DashboardPrefsProvider`, localStorage-persisted).
- **Google Sheets logging** — `sheet_payload` includes `flowRate` when present, logged in a `Flow Rate (L/min)` column (needs redeploying the Apps Script — redeploy gotcha below). Rows before that redeploy, or with no flow reading, get `flowRate: null` via `_with_ntu`'s backfill. **Daily water usage is not logged to Sheets** — a differently-shaped aggregate (`daily_usage` above); only `GET /flow/usage` serves it (the ESP32's Sheets fallback, Firmware below, also skips flow).

## Google Sheets logging & history (`google_apps_script.gs`)

- Every `/update` POST with `temperature`+`turbidity` is relayed fire-and-forget (`asyncio.to_thread`, so a slow/unreachable Google endpoint never blocks the ESP32's response) to a Google Apps Script Web App at `webconfig.json`'s `googleSheetsWebhookUrl`. Empty/missing → the relay and `/history` both no-op.
- `google_apps_script.gs` is reference-only — it does not run from this repo. Paste it into the target spreadsheet's **Extensions > Apps Script** editor and deploy as a Web App (**Execute as: Me**, **Who has access: Anyone**).
- **`doPost` inserts each new reading at row 2** (right after the header) so the newest reading is always the top data row — older rows just sit further down, untouched. Columns: `Timestamp, Temperature (C), Turbidity (raw ADC), TDS (ppm), Flow Rate (L/min), Station`. **Station is the last column, not right after Timestamp** — appending (like Flow Rate was) rather than inserting keeps every existing column's meaning intact for rows written before multi-station support existed; a blank Station cell on those rows reads as `"default"`, same as `main.py`'s `DEFAULT_STATION` sentinel everywhere else. No backfill needed or attempted.
- `doGet` accepts `?seconds=`/`?maxPoints=`/`?station=` (seconds/maxPoints default 900s/400; station optional — omitted or blank returns every station's rows undifferentiated), reads a **leading** slice (rows 2..N, newest first — matching the insert-at-top write above), reverses to chronological order, filters to the window (and to `station` when given, treating a blank Station cell as `"default"`), and stride-downsamples to `maxPoints` so long windows stay fast.
- **`GET /history?window=`** — selectable window (`5m`/`15m`/`1h`/`3h`/`12h`/`24h`, default `15m`, `HISTORY_WINDOWS`). **Two tiers, cheapest first**, merged into one chronological list; the response's `source` field reports which contributed (e.g. `live`, `live+sheet`):
  1. **in-memory `history_buffer`** — the whole live path, answers instantly for anything still in the rolling window; wiped on every restart;
  2. **Google Sheets** — proxies `doGet` with matching `seconds`/`maxPoints` (same-origin, avoiding CORS/redirect issues with Google), consulted *only* for the part of the window the buffer doesn't reach: a fresh restart, or a window longer than the buffer holds.

  The gap test allows `HISTORY_GAP_TOLERANCE_MS` (15s) slack — readings arrive every 2s, so the first row at/after a cutoff is always a second late, and an exact-match test made every steady-state request look like a gap, firing pointless Sheets round-trips. Every row gets `turbidityNtu` (via `_with_ntu`) and `ec` (from `tds` if absent) added uniformly across both sources. There is no local database for reading history — Google Sheets is the durable copy.
- **Redeploy gotcha**: after editing `doGet`/`doPost`, redeploy as a **new version** — otherwise `/exec` keeps serving old code silently. The insert-at-top behavior above lives only in this repo's reference copy until then; the deployed script keeps appending at the bottom (still correct for `/history`, just not "newest at top" by hand) until redeployed.
- Running min/max per sensor (`temperature`/`turbidity`/`tds`) is tracked in `main.py`'s in-memory `sensor_stats` (since server start, resets on restart, shared across dashboards) — not persisted or read from the spreadsheet.

## Push notifications (Web Push)

Threshold-breach alerts as OS-level push notifications, so a subscribed browser is warned even with no tab open — an *outbound* path on top of the same `range_status_for` scoring `/update` already does.

- **VAPID keys**: `webconfig.json`'s `vapidPrivateKeyFile` (default `vapid_private_key.pem`, git-ignored — generate with `vapid --gen` from `py-vapid`), `vapidPublicKey`, `vapidSubject` (`mailto:` contact required by the Push protocol). `vapid_available()` checks the key file exists and public key is non-empty; every `/push/*` endpoint 503s rather than crashing startup if unconfigured.
- **HTTPS listener**: Web Push needs a secure context — `http://localhost` is exempt only on the *same machine*, so a phone/other LAN device needs real HTTPS. `webconfig.json`'s `httpsCertFile`/`httpsKeyFile` (empty by default — off) and `httpsPort` (default 8443) start a **second** uvicorn `Server` alongside the always-on HTTP:8080 one, both serving the same FastAPI `app`. `@app.on_event("startup")` fires per `Server`, so a `_discovery_listener_started` guard stops the UDP listener rebinding port 8888 (would crash the second server). A self-signed cert works for LAN testing but needs its CA trusted per-device (Android refuses an untrusted cert even after "proceed anyway").
- **Subscription storage** (`storage.py`'s `push_subscriptions`) — one row per browser push endpoint (no user/account concept in this app), holding endpoint URL, `p256dh`/`auth` keys, and a `prefs_json` blob (`{param: {warn: bool, danger: bool}}`, default warn=off/danger=on for `temperature`/`turbidity`/`tds`/`ec` — **not** `flow`, no thresholds).
- **Trigger**: `_check_breaches_and_dispatch` runs inline on every `/update` (must see every reading to edge-detect), comparing status against `last_severity` — fires only on the **good→warn/danger transition** (re-arms on recovery). Sends are deferred via `asyncio.create_task`, same pattern as the Sheets relay/DB insert, so a slow push service never delays the ESP32's response.
- **Payload**: `PARAM_DISPLAY` (emoji/label/unit, hand-mirrored from `paramMeta.ts` like `thresholds.py` mirrors `RANGE_BANDS`) builds a title/body, an `icon`/`badge` (app favicon), two action buttons (`view` opens the dashboard, `dismiss` closes) — consumed by the service worker below. A dead subscription (404/410) self-heals by deleting that row.
- **REST API**: `GET /push/vapid-public-key`, `POST /push/subscribe` `{endpoint, keys:{p256dh,auth}, prefs?}`, `POST /push/unsubscribe` `{endpoint}`, `GET /push/preferences?endpoint=`, `PUT /push/preferences` `{endpoint, prefs}`, `POST /push/test` `{endpoint}` (bypasses prefs/thresholds, backs Settings' test-notification button). All 503 if local SQLite storage is disabled.
- **Frontend**: `frontend/src/lib/push.ts` is the browser-side plumbing (Service Worker registration, subscribe/unsubscribe, prefs get/save, `sendTestPush`); `frontend/public/sw.js` is **plain vanilla JS** (not Vite-built — no imports/TypeScript) handling `push`/`notificationclick`. The UI lives in the **Settings** dialog (Frontend below), not a standalone bell icon.

## WiFi provisioning over USB (`frontend/src/lib/webSerial.ts`, formerly `wifi_serial.py`)

Lets the dashboard change the ESP32's WiFi network like an OS WiFi picker — scan, pick, password, connect — credentials persisted on-device (NVS flash, survives power cycles/reflashing). A **separate channel**: when credentials need to change, the ESP32 may have no working WiFi at all, so the normal HTTP/WiFi path can't reach it — the only path available is the **USB cable itself**.

- **Browser-direct (current, default path)**: `WifiPanel.tsx` talks straight to the ESP32 over the **Web Serial API** (`navigator.serial`, wrapped in `webSerial.ts`) — no backend involved. "Connect to board" opens the browser's native USB-device picker; the user picks the port, and every command goes directly from tab to board. Works from *any* machine the tab is open on — no `python main.py` process needed. **Chromium-only** (Chrome/Edge/Opera, not Firefox/Safari), needs a secure context (`https://` or `http://localhost`); unsupported browsers see a plain message.

- **Firmware side** (`esp32.ino`): line-based serial protocol, lines prefixed `WIFI_`/`BACKEND_`/`STATION_` to not collide with the sketch's free-form `Serial.println` output. `WIFI_SCAN` → `WiFi.scanNetworks()`, prints `WIFI_NET|<ssid>|<rssi>|<encrypted:0|1>` per result then `WIFI_SCAN_DONE`. `WIFI_SET|<ssid>|<password>` connects **without saving first**; only on `WL_CONNECTED` does it persist to NVS (namespace `"wifi"`) and reply `WIFI_CONNECTED|<ip>` — a bad password never overwrites a working network. `WIFI_STATUS` reports current state. Commands are read non-blockingly (`readSerialCommands()`), so the board stays reconfigurable over USB anytime. `setup()`'s initial connect wait is **bounded** (20s, not infinite).
- **Station name (multi-station identity)**: `STATION_SET|<name>` trims/caps (40 chars, mirrors `main.py`'s `MAX_STATION_NAME_LEN`) and persists to NVS namespace `"station"` (separate from `"wifi"`/`"backend"`), replying `STATION_SET_OK|<name>` or `STATION_SET_FAILED|<reason>`. `STATION_CLEAR` erases it, replying `STATION_SET_OK|` (empty). `STATION_STATUS` → `STATION_STATUS|<name>` (empty if never set). When set, every `/update` JSON body and Sheets-fallback payload gains a `"station"` field; when unset, the field is omitted entirely so the payload is byte-for-byte identical to a pre-multi-station board — the backend's own `"default"` sentinel applies. See Multi-station support below for the full picture.
- **Fixed backend host override (backend on a different network)**: UDP discovery only ever finds a backend on the ESP32's own subnet, so a cross-network backend needs an explicit host.
  - `BACKEND_SET|<host>|<apiKey>|<https:0|1>` → persists to NVS (namespace `"backend"`, separate from WiFi creds) and POSTs that host directly, skipping discovery; the "3 failed POSTs → rediscover" path re-applies the fixed host.
  - `apiKey` is sent as `X-API-Key` on every `/update`, must match `webconfig.json`'s `updateApiKey`. `https` POSTs to `https://<host>:8443/update` (`httpsBackendPort`, default `httpsPort`) via `WiFiClientSecure` + `setInsecure()` — encrypts in transit but doesn't validate the cert (no CA store on-board).
  - `BACKEND_CLEAR` erases host/key/flag and reverts to discovery. `BACKEND_STATUS` → `<fixed:0|1>|<host>|<backendUrl>|<hasApiKey:0|1>|<https:0|1>` (never echoes the key itself, same as the WiFi password).
  - `BACKEND_TEST` makes the *board* GET `/update/health` (no-op reachability check) over its own WiFi/DNS/TLS stack (a backend-side check can't prove the board's path works). `BACKEND_TEST_OK|<httpCode>` for any HTTP response (401 = reachable, wrong key); `BACKEND_TEST_FAILED|<reason>` for DNS/TCP/TLS/no-WiFi.
  - **This only tells the board an address** — making the backend PC reachable is out of scope. Once it *is* internet-reachable, set `apiKey` and `https`, or anyone who finds `/update` can post forged readings.
- **`webSerial.ts` (browser-side, current)**: mirrors `wifi_serial.py`'s API and wire protocol (`WIFI_SCAN`/`WIFI_SET`/`WIFI_STATUS`, `BACKEND_SET`/`BACKEND_CLEAR`/`BACKEND_STATUS`/`BACKEND_TEST`, `STATION_SET`/`STATION_CLEAR`/`STATION_STATUS`). One module-level `SerialPort` from `navigator.serial.requestPort()`, read via a `TextDecoderStream`-piped loop into a line buffer (Web Serial has no line framing). `connect()` pays the same ~2s DTR/RTS settle delay. A `disconnect` listener resets `WifiPanel.tsx`'s state, clears `wifi-status`/`wifi-backend`/`wifi-station` query caches.
- **Legacy backend-mediated path** (`wifi_serial.py` + `main.py`'s `/wifi/*` routes): still present, unused by the UI — kept for scripted/`curl` use since non-Chromium browsers lack an in-app path. `find_port()` auto-detects the board by USB-serial VID:PID, falling back to the sole port if unique, override via `webconfig.json`'s `esp32SerialPort`. Every function returns `{"ok": False, "error": ...}` rather than raising. Routes: `GET /wifi/status`, `POST /wifi/scan`, `POST /wifi/connect` `{ssid, password}`, `GET /wifi/backend`, `POST /wifi/backend` `{host, apiKey, useHttps}`, `POST /wifi/backend/test` — all 503 with no board on USB, unauthenticated.
- **Frontend** (`WifiPanel.tsx`): a `"WiFi"` entry in the Calibration tab's `SensorList` (not calibratable — just device setup's natural home). Once connected: OS-picker style network list (scan → signal-sorted, lock icon for secured) → password → Connect, ~20s-tolerant loading state matching `WIFI_SET`'s timeout. A second card, "Backend on a different network," sets/clears a fixed host (+ API key, HTTPS toggle) and has a **Test connection** button (`BACKEND_TEST`) toasting reachable vs unreachable as distinct results. A third card, "Station name," sets/clears this board's multi-station identity (`STATION_SET`/`STATION_CLEAR`) — see Multi-station support below.

## Frontend

**One dashboard**, source-controlled, served at `/` by `main.py` (built `frontend/dist/`, mounted last as a root catch-all — `app.mount("/", ...)` registered after every API route).

- **Stack**: Vite + React 19 + TypeScript + Tailwind v4, shadcn/ui + Recharts + Motion + TanStack Query. `npm run build` outputs `frontend/dist/` (git-ignored, along with `node_modules/`); `/` 404s until built at least once. `npm run dev` proxies `/ws/app`, `/history`, `/calibration*`, `/update`, `/push*`, `/flow*`, `/wifi*` to `:8080` for HMR against a live `python main.py`.
- **Left sidebar shell**, three tabs — **Dashboard** (WQI history chart w/ time-range selector + reference lines; live param grid Temperature/Turbidity/TDS/EC/Flow, 30s sparklines, filtered by Settings' toggles; card click → detail modal, min/avg/max, too-high/too-low warning — skipped for Flow; Water Flow/Usage charts below, see Flow sensor above; 3 radial gauges), **Calibration** (turbidity 2-point + TDS/flow k-factors, wired to `/calibration*`, optimistic apply + toast, observed-range min/max/reset — Sensor calibration above; plus **WiFi**, above), **History** (`/history` table + CSV export) — plus theme toggle, EN/ไทย switcher, a **Settings** dialog (gear icon, `SettingsDialog.tsx`) for push prefs and display toggles.
- **Live data**: `useSensorSocket.ts` holds the one shared `/ws/app` connection (via `SensorProvider`) and a ~30s rolling per-parameter sample buffer for sparklines, seeded from `GET /history?window=5m` on mount so a reload shows recent data immediately instead of starting blank. **No fake-data fallback**: on disconnect or >5s silence it flips `connected`/"Offline" but leaves the last reading frozen — never fabricates numbers (an earlier idle-random-data fallback was removed for this reason).
- **Guided tour** (`frontend/src/components/tour/`) — a 10-step first-run walkthrough: `TourProvider` owns state, `TourOverlay` renders the spotlight, `tourSteps.ts` is the step list, `TourHelpButton` replays it on demand. Three mechanics: (1) auto-runs once per browser, gated on a **versioned** localStorage flag (`hydro-tour-v1-seen`) — bump it to re-show after a redesign; (2) steps target elements by **`data-tour="..."` attribute**, resolved via `document.querySelector` at render time, so renaming/dropping one silently breaks that step; (3) a step may carry a `view` to switch tabs and bring its target into the DOM. Step copy lives in `strings.ts` (`tour.*` keys).
- Two earlier dashboards (`web-react/`, a prebuilt SPA at `/`; and a hand-built `web/index.html`+`app.js`+`style.css` at `/classic`) were **removed**, along with the later standalone `/calibrate` page (`web/calibrate.html`) once the frontend's own Calibration tab covered the same ground. The `web/` directory itself is gone — none of its files or routes exist any more. **Do not add code paths or comments referring to any of them.**

## Firmware (`firmware/esp32/esp32.ino`)

Single ESP32 dev board (not ESP32-CAM — no camera). WiFi credentials are provisioned over USB and persisted to NVS flash (WiFi provisioning above) — the hardcoded `defaultSsid`/`defaultPassword` consts are used only on a fresh, never-provisioned board. Not auto-synced with `main.py`; an endpoint contract change there needs a matching firmware update.

Reads DS18B20 temperature, analog turbidity, TDS, and flow-sensor pulses every 2s and POSTs JSON `{temperature, turbidity, tdsVoltage, flowPulses}` (plus `station` once a station name is set — Multi-station support above; omitted entirely otherwise) to `http://<backendIP>:8080/update` — **all raw**: `turbidity` = averaged ADC, `tdsVoltage` = raw voltage, `flowPulses` = pulses over that interval. TDS formula, temp compensation, NTU conversion, and flow k-factor live on the **backend** (Sensor calibration below), recalibratable without reflashing. (Legacy firmware POSTing pre-computed `tds`, or omitting `flowPulses`, still works.) Backend IP isn't hardcoded: `discoverBackend()` broadcasts `HYDRO_DISCOVER` over UDP:8888, taking the replying host's IP. Discovery runs once at boot (blocking, **bounded to 20s**) and again after 3 consecutive `/update` failures (`consecutiveFailures`/`backendKnown`); `loop()` keeps retrying on its own timer until then.

**Google Sheets fallback (no backend needed)**: when unreachable but Wi-Fi/internet still work, readings go into a 30-entry circular buffer (`sheetsFallbackBufferPush`, ~60s at 2s cadence), flushed once per `sheetsFallbackInterval` (60s) by POSTing each reading **individually to the same Apps Script Web App** the Sheets relay uses (`doPost` doesn't distinguish the paths). Overflow drops the oldest reading; buffer clears after a flush and again once the backend POST succeeds. Requires `sheetsWebhookUrl` to match `googleSheetsWebhookUrl`. **Calibration caveat**: `turbidity` is raw ADC, recalibrating retroactively via `_with_ntu`; `tds` can't — no raw-voltage column to backfill — so firmware sends **uncalibrated** ppm (`dfrobotUncalibratedPpm`, k=1.0), never the personal k-factor. `flowPulses` is **not** included — only temperature/turbidity/TDS. `station` **is** included (when this board has a station name set — Multi-station support above), same as the primary `/update` path.

### Wiring

The turbidity NTU formula (`-1120.4·V² + 5742.3·V - 4353.8`) is calibrated for a 5V-powered analog turbidity sensor (~0–4.5V output, DFRobot Gravity-style). ESP32 GPIOs are strictly 3.3V (not 5V-tolerant like some ESP8266 boards), so the sensor's output is divided down before the ADC pin (see divider below).

| Sensor | Pin | ESP32 pin | Notes |
|---|---|---|---|
| DS18B20 (temp) | VCC | 3.3V | Keeps OneWire data HIGH level at safe 3.3V |
| | GND | GND | |
| | DATA | GPIO13 | Needs a 4.7kΩ pull-up to 3.3V (skip if the probe has one). **Not GPIO12** — a boot-strapping pin (sets flash voltage); the pull-up would hold it HIGH at reset and can prevent booting |
| Turbidity sensor | VCC | 5V / VIN | Needs a true 5V rail for its rated output curve |
| | GND | GND (shared) | |
| | OUT | → divider → GPIO34 | GPIO34 is ADC1 (input-only, no internal pulls); avoid ADC2 pins (0,2,12–15,25–27) since Wi-Fi disables ADC2 |
| TDS Meter V1.0 | VCC | 3.3V | Accepts 3.3–5.5V; output voltage independent of supply |
| | GND | GND (shared) | |
| | A (signal) | GPIO35 (direct, no divider) | Tops out at ~2.3V, under the 3.3V ADC limit. Another ADC1 pin, separate from GPIO34/GPIO13 |
| YF-S201 (flow) | VCC | 5V / VIN | Needs 5V for its rated output |
| | GND | GND (shared) | |
| | Signal | GPIO27 (direct, `INPUT_PULLUP`) | **Digital** pulse input, not analog — the ADC2-avoid note above is about `analogRead`, doesn't apply here, so GPIO27 is fine despite being ADC2. Open-collector output needs a pull-up (`INPUT_PULLUP`'s internal one suffices) |

Divider (turbidity only): R1 = 10kΩ (OUT → node), R2 = 20kΩ (node → GND), node → GPIO34. Scales 0–4.5V to 0–3.0V (margin under the 3.3V limit); firmware multiplies by 1.5 (`dividerRecoveryFactor`) to recover the real voltage. Re-verify NTU calibration against known references once wired — tuned for the original ESP8266 path, and ESP32's ADC has known non-linearity near its extremes.

TDS reading uses DFRobot's temperature-compensated formula, reusing the DS18B20's `temperatureC` (coefficient `1 + 0.02·(T-25)`) rather than assuming a fixed 25°C, since raw output drifts with water temperature.

Flow sensor uses `attachInterrupt(digitalPinToInterrupt(FLOW_PIN), onFlowPulse, RISING)` with a `volatile` pulse counter guarded by `portENTER_CRITICAL`/`portEXIT_CRITICAL` (a `portMUX_TYPE`, not just `noInterrupts()` — ESP32 is dual-core, a simple interrupt-disable doesn't protect against the other core) — the only interrupt-driven sensor here, everything else is synchronous `analogRead` polled once per `broadcastInterval` tick. The counter resets to 0 each tick, so `flowPulses` always means "pulses since the last POST."

## Knowledge graph (`graphify-out/`)

This repo has a [graphify](https://github.com/Graphify-Labs/graphify) knowledge graph over it — `graphify-out/graph.html`/`GRAPH_REPORT.md`/`graph.json`, git-ignored, local-only, mapping how code/docs/screenshots relate. Regenerate with `graphify . --update` (incremental) from the repo root, or `--code-only` to skip doc/image re-extraction when no `GEMINI_API_KEY`/`GOOGLE_API_KEY` is set; query with `graphify query "<question>"`.
