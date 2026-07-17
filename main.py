import asyncio
import os
import json
import mimetypes
import time
import urllib.request
from urllib.parse import parse_qs
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI()

CONFIG_PATH = "webconfig.json"
try:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        webconfig = json.load(f)
except FileNotFoundError:
    webconfig = {}

BUILD_DIR = webconfig.get("staticDir", "Build")
GOOGLE_SHEETS_WEBHOOK_URL = webconfig.get("googleSheetsWebhookUrl", "")

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


# --- Turbidity ADC -> NTU calibration ---------------------------------------
# The firmware reports turbidity as an averaged raw ADC count (0-4095). Higher ADC
# means clearer water (more light reaches the sensor), so NTU falls as ADC rises.
# Measured clean water sits around ADC 1700-2500, treated as ~0 NTU; below the clean
# threshold the water is dirtier and NTU climbs linearly to TURBIDITY_NTU_MAX.
# The dashboard shows this NTU value; the raw ADC is what's logged to Google Sheets.
# These are rough anchors -- retune against known reference samples.
# NOTE: currently BYPASSED (see update_sensor) -- turbidity is shown/stored as raw
# averaged ADC for now, until the NTU curve is calibrated.
TURBIDITY_ADC_CLEAN = 1700   # at/above this ADC => clean water, 0 NTU
TURBIDITY_ADC_DIRTY = 0      # at/below this ADC => maximum turbidity
TURBIDITY_NTU_MAX = 3000     # NTU reported at the dirty anchor


def adc_to_ntu(adc: float) -> float:
    if adc >= TURBIDITY_ADC_CLEAN:
        return 0.0
    span = TURBIDITY_ADC_CLEAN - TURBIDITY_ADC_DIRTY
    if span <= 0:
        return 0.0
    ntu = (TURBIDITY_ADC_CLEAN - adc) / span * TURBIDITY_NTU_MAX
    return round(max(0.0, min(TURBIDITY_NTU_MAX, ntu)), 1)


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
            # Turbidity is shown and stored as the averaged raw ADC for now. The NTU
            # conversion (adc_to_ntu) is left in place but bypassed until it's calibrated.
            payload["turbidity"] = float(data["turbidity"])
            if "tds" in data:
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
            # Google Sheets logs the same averaged raw ADC that's shown on the dashboard.
            sheet_payload = {
                "source": payload["source"],
                "timestamp": payload["timestamp"],
                "temperature": payload["temperature"],
                "turbidity": payload["turbidity"],
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

