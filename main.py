import asyncio
import os
import sys
import json
import mimetypes
import time
import datetime
import urllib.request
from collections import deque
from urllib.parse import parse_qs
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# Windows consoles default to cp1252, where the emoji in the startup prints below raise
# UnicodeEncodeError and crash the server on launch. Force UTF-8 so `python main.py` just works.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

app = FastAPI()

CONFIG_PATH = "webconfig.json"
try:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        webconfig = json.load(f)
except FileNotFoundError:
    webconfig = {}

BUILD_DIR = webconfig.get("staticDir", "Build")
GOOGLE_SHEETS_WEBHOOK_URL = webconfig.get("googleSheetsWebhookUrl", "")
CALIBRATION_PATH = webconfig.get("calibrationFile", "calibration.json")

class BrotliStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            if path.endswith(".br"):
                response.headers["Content-Encoding"] = "br"
                # Use original file type by stripping the .br extension.
                original_type = mimetypes.guess_type(path[:-3])[0] if path.endswith('.br') else None
                response.headers.setdefault("Content-Type", original_type or "application/javascript")
            elif path.endswith(".gz"):
                response.headers["Content-Encoding"] = "gzip"
                original_type = mimetypes.guess_type(path[:-3])[0] if path.endswith('.gz') else None
                response.headers.setdefault("Content-Type", original_type or "application/octet-stream")
        return response

if os.path.isdir(BUILD_DIR):
    app.mount(f"/{BUILD_DIR}", BrotliStaticFiles(directory=BUILD_DIR), name="build")
    print(f"✅ Mounted {BUILD_DIR} directory for WebGL static assets.")
else:
    print(f"⚠️ {BUILD_DIR} directory not found; WebGL static asset mount disabled.")

if os.path.isdir("web"):
    app.mount("/static", StaticFiles(directory="web"), name="static")
    print("✅ Mounted web directory for frontend static assets at /static.")
else:
    print("⚠️ web directory not found; frontend static mount disabled.")

# React SPA dashboard (built from the Lovable "river-watch" project into web-react/).
# It's a TanStack Start SPA that only works served at the site root "/" (its prerendered
# shell + router assume root; a subpath basepath causes hydration mismatch), so it's the
# primary dashboard at "/" (see get_index) and its assets are served from /assets/*.
# The original vanilla dashboard is preserved at /classic (see get_classic_index).
if os.path.isdir("web-react/assets"):
    app.mount("/assets", StaticFiles(directory="web-react/assets"), name="react_assets")
    print("✅ Mounted React SPA dashboard assets at /assets.")
else:
    print("⚠️ web-react not found; React SPA dashboard disabled (falling back to vanilla at /).")

if GOOGLE_SHEETS_WEBHOOK_URL:
    print("✅ Google Sheets relay enabled for /update readings.")
else:
    print("⚠️ googleSheetsWebhookUrl not set in webconfig.json; Google Sheets relay disabled.")

print("Starting FastAPI Backend Server...")

DISCOVERY_PORT = 8888
DISCOVERY_REQUEST = b"HYDRO_DISCOVER"
DISCOVERY_REPLY = b"HYDRO_HERE"

class DiscoveryProtocol(asyncio.DatagramProtocol):
    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        if data == DISCOVERY_REQUEST:
            self.transport.sendto(DISCOVERY_REPLY, addr)

@app.on_event("startup")
async def start_discovery_listener():
    loop = asyncio.get_event_loop()
    await loop.create_datagram_endpoint(
        DiscoveryProtocol,
        local_addr=("0.0.0.0", DISCOVERY_PORT),
    )
    print(f"📡 UDP discovery listener active on port {DISCOVERY_PORT} (firmware IP auto-discovery)")

ui_clients = set()
ui_clients_lock = asyncio.Lock()

# Running min/max per parameter, tracked since server start (reset on restart).
# Living on the backend (not per-browser) so every connected dashboard shows the
# same range and it survives page refreshes. Mutated only from the event loop in
# update_sensor, so no lock is needed.
STAT_KEYS = ("temperature", "turbidity", "tds")
sensor_stats: dict = {}


def _update_stats(payload: dict) -> None:
    for key in STAT_KEYS:
        if key not in payload:
            continue
        value = payload[key]
        current = sensor_stats.get(key)
        if current is None:
            sensor_stats[key] = {"min": value, "max": value}
        else:
            current["min"] = min(current["min"], value)
            current["max"] = max(current["max"], value)


def _stats_snapshot() -> dict:
    # Deep-ish copy so a snapshot handed to a coroutine/broadcast can't be mutated
    # underneath it by a later reading.
    return {key: dict(stat) for key, stat in sensor_stats.items()}


async def broadcast_sensor_update(payload: dict) -> None:
    disconnected_clients = []
    message = json.dumps({"type": "sensor_update", "payload": payload})

    async with ui_clients_lock:
        print(f"Broadcasting sensor update to {len(ui_clients)} connected UI clients")
        for client in list(ui_clients):
            try:
                await client.send_text(message)
            except Exception:
                disconnected_clients.append(client)

        for client in disconnected_clients:
            ui_clients.discard(client)


def _post_to_google_sheets(payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        GOOGLE_SHEETS_WEBHOOK_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        print(f"⚠️ Failed to relay reading to Google Sheets: {exc}")


async def relay_to_google_sheets(payload: dict) -> None:
    if not GOOGLE_SHEETS_WEBHOOK_URL:
        return
    # Runs in a thread so a slow/unreachable Google endpoint never blocks the event
    # loop or delays the ESP32's /update response.
    await asyncio.to_thread(_post_to_google_sheets, payload)


# --- Sensor calibration ------------------------------------------------------
# Calibration is owned by the backend (not the firmware) so sensors can be recalibrated
# live with no reflash. The firmware streams RAW values -- turbidity as an averaged ADC
# count (0-4095), TDS as a raw sensor voltage -- and the helpers below convert them using
# the coefficients persisted in calibration.json.
#
#   turbidity: 2-point linear ADC -> NTU. Higher ADC = clearer water, so slope is negative.
#              Uncalibrated (fewer than 2 points) => apply_turbidity returns None (no NTU).
#   tds:       DFRobot temperature-compensated ppm formula (moved here from the firmware)
#              scaled by a single k-factor fitted against one known-ppm solution.
#
# The mutable in-memory state is mutated only from the event loop (update_sensor + the
# calibration endpoints), so no lock is needed.


def _default_calibration() -> dict:
    return {
        "turbidity": {"model": "linear2", "points": [], "coefficients": None, "updated": None},
        "tds": {"model": "kfactor", "points": [], "coefficients": {"k": 1.0}, "updated": None},
    }


def _load_calibration() -> dict:
    calib = _default_calibration()
    try:
        with open(CALIBRATION_PATH, encoding="utf-8") as f:
            stored = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return calib
    for sensor in ("turbidity", "tds"):
        if isinstance(stored.get(sensor), dict):
            calib[sensor].update(stored[sensor])
    return calib


calibration = _load_calibration()
calibration_mode = False

# Latest raw reading per sensor plus a short rolling buffer, so a calibration "capture"
# can average out electrical noise instead of grabbing a single instant.
latest_raw: dict = {"turbidity": None, "tdsVoltage": None, "temperature": None}
_raw_buffers = {"turbidity": deque(maxlen=5), "tdsVoltage": deque(maxlen=5)}


def _save_calibration() -> None:
    with open(CALIBRATION_PATH, "w", encoding="utf-8") as f:
        json.dump(calibration, f, indent=2)


def _now_iso() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def _recompute_turbidity() -> None:
    # 2-point linear fit. With >2 points, use the first and last by raw ADC so the line
    # spans the full captured range; a single point can't define a slope.
    points = calibration["turbidity"]["points"]
    if len(points) < 2:
        calibration["turbidity"]["coefficients"] = None
        return
    ordered = sorted(points, key=lambda p: p["raw"])
    p1, p2 = ordered[0], ordered[-1]
    if p2["raw"] == p1["raw"]:
        calibration["turbidity"]["coefficients"] = None
        return
    slope = (p2["reference"] - p1["reference"]) / (p2["raw"] - p1["raw"])
    intercept = p1["reference"] - slope * p1["raw"]
    calibration["turbidity"]["coefficients"] = {"slope": slope, "intercept": intercept}


def _dfrobot_ppm(voltage: float, temperature_c) -> float:
    # DFRobot TDS Meter V1.0 official formula, temperature-compensated against the DS18B20
    # reading (raw output drifts with water temperature, nominally calibrated at 25C).
    temp = temperature_c if isinstance(temperature_c, (int, float)) else 25.0
    coeff = 1.0 + 0.02 * (temp - 25.0)
    v = voltage / coeff if coeff else voltage
    ppm = (133.42 * v * v * v - 255.86 * v * v + 857.39 * v) * 0.5
    return max(0.0, ppm)


def _recompute_tds() -> None:
    # Single-point k-factor: k = known_ppm / dfrobot_ppm at the captured voltage/temp.
    points = calibration["tds"]["points"]
    if not points:
        calibration["tds"]["coefficients"] = {"k": 1.0}
        return
    p = points[-1]
    base = _dfrobot_ppm(p["rawVoltage"], p.get("temperature", 25.0))
    k = (p["reference"] / base) if base > 0 else 1.0
    calibration["tds"]["coefficients"] = {"k": k}


def apply_turbidity(adc: float):
    coeffs = calibration["turbidity"]["coefficients"]
    if not coeffs:
        return None
    ntu = coeffs["slope"] * adc + coeffs["intercept"]
    return round(max(0.0, ntu), 1)


def apply_tds(voltage: float, temperature_c) -> float:
    k = (calibration["tds"]["coefficients"] or {}).get("k", 1.0)
    return round(k * _dfrobot_ppm(voltage, temperature_c), 1)


@app.post("/update")
async def update_sensor(request: Request):
    try:
        data = await request.json()
        payload = {
            "source": "arduino",
            "timestamp": int(time.time()),
        }

        if "temperature" in data and "turbidity" in data:
            payload["temperature"] = float(data["temperature"])
            # Turbidity arrives as the averaged raw ADC and is kept in `turbidity` (both
            # dashboards read that key). The calibrated NTU rides along in `turbidityNtu`
            # when a turbidity calibration is active (else None).
            turbidity_adc = float(data["turbidity"])
            ntu = apply_turbidity(turbidity_adc)
            # `turbidityRaw` always carries the raw averaged ADC (for the calibration page +
            # honest Google Sheets logging). The primary `turbidity` field carries calibrated
            # NTU once a calibration exists, else falls back to raw ADC -- the React SPA (a
            # prebuilt bundle we can't edit) reads `turbidity` and labels it NTU, so this makes
            # it show real NTU. `turbidityUnit` tells the editable dashboards which unit it is.
            payload["turbidityRaw"] = turbidity_adc
            payload["turbidityNtu"] = ntu
            if ntu is not None:
                payload["turbidity"] = ntu
                payload["turbidityUnit"] = "NTU"
            else:
                payload["turbidity"] = turbidity_adc
                payload["turbidityUnit"] = "ADC"
            latest_raw["turbidity"] = turbidity_adc
            _raw_buffers["turbidity"].append(turbidity_adc)

            latest_raw["temperature"] = payload["temperature"]

            # TDS: prefer the raw voltage from current firmware (backend computes ppm via
            # calibration). Fall back to a legacy pre-computed `tds` ppm from an un-reflashed
            # board so the old firmware keeps working (backward-compatible contract).
            if "tdsVoltage" in data:
                tds_voltage = float(data["tdsVoltage"])
                payload["tdsVoltage"] = tds_voltage
                payload["tds"] = apply_tds(tds_voltage, payload["temperature"])
                latest_raw["tdsVoltage"] = tds_voltage
                _raw_buffers["tdsVoltage"].append(tds_voltage)
            elif "tds" in data:
                payload["tds"] = float(data["tds"])
        else:
            text = await request.body()
            if not text:
                return JSONResponse({"error": "missing body"}, status_code=400)

            parsed = parse_qs(text.decode("utf-8", errors="ignore"), keep_blank_values=True)
            water_level = parsed.get("water_level", [None])[0]
            if water_level is None:
                return JSONResponse({"error": "missing water_level"}, status_code=400)

            payload["water_level"] = int(float(water_level))

        _update_stats(payload)
        payload["stats"] = _stats_snapshot()

        print(f"Received sensor update: {payload}")
        await broadcast_sensor_update(payload)
        if "temperature" in payload:
            # Google Sheets keeps logging the raw averaged turbidity ADC (its column header is
            # "Turbidity (raw ADC)"), independent of what unit the dashboards display.
            sheet_payload = {
                "source": payload["source"],
                "timestamp": payload["timestamp"],
                "temperature": payload["temperature"],
                "turbidity": payload.get("turbidityRaw", payload["turbidity"]),
            }
            if "tds" in payload:
                sheet_payload["tds"] = payload["tds"]
            asyncio.create_task(relay_to_google_sheets(sheet_payload))
        return JSONResponse({"ok": True, "payload": payload})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)


HISTORY_WINDOW_SECONDS = 15 * 60  # dashboard graph shows only the last 15 minutes


@app.get("/history")
async def get_history():
    # Reads recent readings back from the Google Sheet (via the Apps Script doGet) and
    # returns only the last 15 minutes. Proxied here (server-side) so the dashboard
    # fetch stays same-origin -- no browser CORS/redirect issues with Google.
    if not GOOGLE_SHEETS_WEBHOOK_URL:
        return JSONResponse({"rows": [], "windowSeconds": HISTORY_WINDOW_SECONDS})

    def fetch() -> str:
        req = urllib.request.Request(GOOGLE_SHEETS_WEBHOOK_URL, method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read().decode("utf-8")

    try:
        raw = await asyncio.to_thread(fetch)
        data = json.loads(raw)
    except Exception as exc:
        print(f"⚠️ Failed to read history from Google Sheets: {exc}")
        return JSONResponse(
            {"rows": [], "windowSeconds": HISTORY_WINDOW_SECONDS, "error": str(exc)}
        )

    cutoff_ms = (time.time() - HISTORY_WINDOW_SECONDS) * 1000
    rows = [
        r
        for r in data.get("rows", [])
        if isinstance(r.get("timestamp"), (int, float)) and r["timestamp"] >= cutoff_ms
    ]
    return JSONResponse({"rows": rows, "windowSeconds": HISTORY_WINDOW_SECONDS})


# --- Calibration API ---------------------------------------------------------
# Drives the standalone /calibrate page. State lives in the `calibration` dict and is
# only persisted to calibration.json on an explicit save, so captures can be reviewed
# (and discarded) before they take effect on the live stream.


def _avg_raw(key: str):
    buf = _raw_buffers.get(key)
    if buf:
        return sum(buf) / len(buf)
    return latest_raw.get(key)


@app.get("/calibrate")
async def get_calibrate_page():
    page = "web/calibrate.html"
    if not os.path.isfile(page):
        raise HTTPException(status_code=404, detail="Calibration page not found")
    return FileResponse(page)


@app.get("/calibration")
async def get_calibration():
    return JSONResponse(
        {
            "mode": calibration_mode,
            "turbidity": calibration["turbidity"],
            "tds": calibration["tds"],
            "latestRaw": {
                "turbidity": latest_raw["turbidity"],
                "tdsVoltage": latest_raw["tdsVoltage"],
                "temperature": latest_raw["temperature"],
            },
        }
    )


@app.post("/calibration/mode")
async def set_calibration_mode(request: Request):
    global calibration_mode
    body = await request.json()
    calibration_mode = bool(body.get("enabled"))
    return JSONResponse({"mode": calibration_mode})


@app.post("/calibration/capture")
async def capture_calibration_point(request: Request):
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in ("turbidity", "tds"):
        return JSONResponse({"error": "sensor must be 'turbidity' or 'tds'"}, status_code=400)
    try:
        reference = float(body["reference"])
    except (KeyError, TypeError, ValueError):
        return JSONResponse({"error": "reference (numeric) is required"}, status_code=400)
    label = str(body.get("label", ""))

    if sensor == "turbidity":
        raw = _avg_raw("turbidity")
        if raw is None:
            return JSONResponse({"error": "no live turbidity reading yet"}, status_code=409)
        calibration["turbidity"]["points"].append(
            {"raw": round(raw, 1), "reference": reference, "label": label}
        )
        _recompute_turbidity()
    else:
        raw = _avg_raw("tdsVoltage")
        if raw is None:
            return JSONResponse({"error": "no live TDS voltage reading yet"}, status_code=409)
        calibration["tds"]["points"].append(
            {
                "rawVoltage": round(raw, 4),
                "reference": reference,
                "label": label,
                "temperature": latest_raw["temperature"] if latest_raw["temperature"] is not None else 25.0,
            }
        )
        _recompute_tds()

    return JSONResponse({sensor: calibration[sensor]})


@app.delete("/calibration/point")
async def delete_calibration_point(request: Request):
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in ("turbidity", "tds"):
        return JSONResponse({"error": "sensor must be 'turbidity' or 'tds'"}, status_code=400)
    try:
        index = int(body["index"])
        calibration[sensor]["points"].pop(index)
    except (KeyError, TypeError, ValueError, IndexError):
        return JSONResponse({"error": "valid point index required"}, status_code=400)
    (_recompute_turbidity if sensor == "turbidity" else _recompute_tds)()
    return JSONResponse({sensor: calibration[sensor]})


@app.post("/calibration/save")
async def save_calibration():
    now = _now_iso()
    for sensor in ("turbidity", "tds"):
        calibration[sensor]["updated"] = now
    try:
        _save_calibration()
    except OSError as exc:
        return JSONResponse({"error": f"failed to write {CALIBRATION_PATH}: {exc}"}, status_code=500)
    print(f"💾 Calibration saved to {CALIBRATION_PATH}")
    return JSONResponse({"ok": True, "turbidity": calibration["turbidity"], "tds": calibration["tds"]})


@app.post("/calibration/reset")
async def reset_calibration(request: Request):
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in ("turbidity", "tds"):
        return JSONResponse({"error": "sensor must be 'turbidity' or 'tds'"}, status_code=400)
    calibration[sensor] = _default_calibration()[sensor]
    return JSONResponse({sensor: calibration[sensor]})


@app.get("/")
async def get_index():
    print("🌐 Web Browser accessed the dashboard endpoint!")
    # Primary dashboard: the React SPA (web-react/). Falls back to the vanilla dashboard
    # if the React build isn't present.
    react_index = "web-react/index.html"
    if os.path.isfile(react_index):
        return FileResponse(react_index)
    if not os.path.isfile(webconfig.get("indexFile", "index.html")):
        raise HTTPException(status_code=404, detail="Index file not found")
    return FileResponse(webconfig.get("indexFile", "index.html"))


@app.get("/classic")
async def get_classic_index():
    # Original hand-built vanilla dashboard (web/), wired to real ESP32 sensor data via /ws/app.
    # Its assets load from /static/*, so it works served from any path.
    index_file = webconfig.get("indexFile", "index.html")
    if not os.path.isfile(index_file):
        raise HTTPException(status_code=404, detail="Classic index file not found")
    return FileResponse(index_file)


@app.websocket("/ws/app")
async def websocket_app(websocket: WebSocket):
    await websocket.accept()
    print("🖥️ Web UI connected to /ws/app")

    async with ui_clients_lock:
        ui_clients.add(websocket)

    # Prime the freshly connected dashboard with the current min/max so the range
    # is visible right away instead of only after the next reading arrives.
    if sensor_stats:
        try:
            await websocket.send_text(
                json.dumps({"type": "sensor_update", "payload": {"stats": _stats_snapshot()}})
            )
        except Exception:
            pass

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        print("📴 Web UI disconnected from /ws/app")
    finally:
        async with ui_clients_lock:
            ui_clients.discard(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8080,
        reload=True,
    )

