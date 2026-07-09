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
- **Sensor ingestion** — `POST /update`: accepts either JSON body (`{temperature, turbidity}` from the ESP32, plus an optional `tds` field) or form-urlencoded body with `water_level`. Normalizes into a payload with `source`/`timestamp` and broadcasts it to all connected UI WebSocket clients as a `sensor_update` message.
- **Dashboard fan-out** — `WS /ws/app`: browser dashboards connect here and receive `sensor_update` JSON messages. Connected clients are tracked in the `ui_clients` set guarded by `ui_clients_lock`; disconnects are pruned opportunistically during broadcast.
- **Backend discovery** — a UDP listener (`DiscoveryProtocol`, started via `@app.on_event("startup")`) binds `0.0.0.0:8888` and replies `HYDRO_HERE` to any `HYDRO_DISCOVER` packet, so firmware on the LAN can find this machine's current IP without it being hardcoded. Requires Windows Firewall to allow inbound UDP on port 8888 (added locally via `netsh advfirewall firewall add rule name="HydroMonitor UDP Discovery" dir=in action=allow protocol=UDP localport=8888` — a fresh machine won't have this rule and discovery will silently time out until it's added).

## Frontend (`web/`)

Plain HTML/CSS/JS dashboard (no build step, no framework) served as static files.

- `index.html` — dashboard shell; loads Chart.js from a CDN and `app.js`/`style.css` from `/static`.
- `app.js` — opens a WebSocket to `/ws/app` on the same host, port 8080. Expects either `{type: "sensor_update", payload: {temperature, turbidity, tds}}` or a flat `{temperature, turbidity, tds}` message and pushes points into a Chart.js line chart (temp on left axis, turbidity on right, TDS on a third hidden axis so it auto-scales without adding visual clutter), capped at 25 rolling data points. On disconnect, falls back to `startSimulation()`, which fabricates readings every 2s so the UI stays populated when nothing is connected.
- `index.html.bak` / `index.html.new` are stray leftover files, not referenced by any code path — check before treating either as current.

## Firmware (`firmware/esp32/esp32.ino`)

Single ESP32 dev board (not ESP32-CAM — no camera). Hardcodes Wi-Fi credentials. Not auto-synced with `main.py`; changing an endpoint contract there requires a matching firmware update.

Reads DS18B20 temperature, analog turbidity, and TDS every 2s and POSTs JSON `{temperature, turbidity, tds}` to `http://<backendIP>:8080/update`. The backend IP is not hardcoded: `discoverBackend()` broadcasts `HYDRO_DISCOVER` over UDP on port 8888 and takes the replying host's IP as the backend address, so it survives the backend PC's DHCP lease changing. Discovery runs once at boot (blocking retry loop) and again automatically if `/update` POSTs fail 3 times in a row (`consecutiveFailures` / `backendKnown`), so a mid-run IP change self-heals within a few broadcast cycles. Requires `main.py`'s discovery listener (see above) and a working Wi-Fi broadcast domain. Registers mDNS as `hydromonitor.local` but doesn't actually use that hostname anywhere — that's unrelated leftover, not part of backend discovery.

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
