import asyncio
import hmac
import os
import sys
import json
import mimetypes
import time
import datetime
import urllib.request
from collections import deque
from urllib.parse import parse_qs, urlencode
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pywebpush import webpush, WebPushException

import storage
import thresholds
import wifi_serial

# Windows consoles default to cp1252, where the emoji in the startup prints below raise
# UnicodeEncodeError and crash the server on launch. Force UTF-8 so `python main.py` just works.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

app = FastAPI()
app.add_middleware(GZipMiddleware, minimum_size=1024)

CONFIG_PATH = "webconfig.json"
try:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        webconfig = json.load(f)
except FileNotFoundError:
    webconfig = {}

BUILD_DIR = webconfig.get("staticDir", "Build")
GOOGLE_SHEETS_WEBHOOK_URL = webconfig.get("googleSheetsWebhookUrl", "")
CALIBRATION_PATH = webconfig.get("calibrationFile", "calibration.json")
# Local SQLite file for push subscriptions + daily water usage only (see storage.py).
# Reading history is NOT stored here -- it lives in the in-memory buffer and Google Sheets.
# Set "historyDbFile" to "" to disable it (push subscriptions won't survive a restart and
# daily usage won't persist, but everything else keeps working).
HISTORY_DB_PATH = webconfig.get("historyDbFile", "history.db")
# Web Push (see push notification section below). Missing VAPID key file -> push endpoints
# degrade to 503 rather than crashing startup, matching the existing degrade-not-crash
# pattern used by storage.init/the Sheets webhook.
VAPID_PRIVATE_KEY_FILE = webconfig.get("vapidPrivateKeyFile", "vapid_private_key.pem")
VAPID_PUBLIC_KEY = webconfig.get("vapidPublicKey", "")
VAPID_CLAIM_SUB = webconfig.get("vapidSubject", "mailto:admin@example.com")
# HTTPS listener (Web Push requires a secure context; http://localhost is only exempt on
# the same machine). Empty cert/key -> HTTPS stays off, HTTP:8080 behavior is unchanged.
HTTPS_CERT_FILE = webconfig.get("httpsCertFile", "")
HTTPS_KEY_FILE = webconfig.get("httpsKeyFile", "")
HTTPS_PORT = int(webconfig.get("httpsPort", 8443))


def https_enabled() -> bool:
    """Only enable HTTPS when both configured files exist on disk. Missing certs should
    degrade to plain HTTP instead of crashing the process on startup."""
    return bool(HTTPS_CERT_FILE and HTTPS_KEY_FILE and os.path.exists(HTTPS_CERT_FILE) and os.path.exists(HTTPS_KEY_FILE))


# USB WiFi provisioning (see wifi_serial.py). Empty/missing -> auto-detect the ESP32's port by
# its USB-to-serial chip; set this only if auto-detect picks the wrong device.
wifi_serial.configure(webconfig.get("esp32SerialPort", "") or None)
# Shared secret for POST /update (see the update_sensor auth check below). Empty/missing ->
# auth stays OFF and /update accepts any request, matching every prior version of this app
# (same-LAN-only, no exposure). Set this to a random string once the ESP32 might reach this
# backend from outside the LAN (see the fixed-backend-host override in WiFi provisioning) --
# an internet-reachable /update with no auth lets anyone inject fake sensor readings or spam
# the Google Sheets relay/push notifications. The ESP32 sends it back via the X-API-Key header
# (set through the same USB provisioning channel as WIFI_SET/BACKEND_SET, see esp32.ino).
UPDATE_API_KEY = webconfig.get("updateApiKey", "")


def vapid_available() -> bool:
    return os.path.exists(VAPID_PRIVATE_KEY_FILE) and bool(VAPID_PUBLIC_KEY)

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

class SpaStaticFiles(StaticFiles):
    """StaticFiles for a Vite build: `no-store` on the HTML shell, long cache on hashed assets.

    Vite emits content-hashed asset filenames (index-<hash>.js), so those are safe to cache
    immutably -- a rebuild produces a new name. `index.html` is the opposite: its name never
    changes but its contents point at the current hash, so a cached shell keeps requesting a
    bundle that no longer exists and the app silently loads stale code (hit for real during
    this build). Only the shell needs `no-store`.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # Normalize separators first: on Windows StaticFiles hands back OS-native paths
        # (assets\index-<hash>.js), so a "/assets/" substring test silently never matches.
        normalized = path.replace("\\", "/").lstrip("/")
        if normalized in ("", ".") or normalized.endswith(".html"):
            response.headers["Cache-Control"] = "no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        elif normalized.startswith("assets/"):
            response.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
        return response


if GOOGLE_SHEETS_WEBHOOK_URL:
    print("✅ Google Sheets relay enabled for /update readings.")
else:
    print("⚠️ googleSheetsWebhookUrl not set in webconfig.json; Google Sheets relay disabled.")

if HISTORY_DB_PATH and storage.init(HISTORY_DB_PATH):
    print(f"✅ Local database at {HISTORY_DB_PATH} (push subscriptions + daily water usage).")
else:
    print("⚠️ Local database disabled; push subscriptions and daily water usage won't persist.")

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

_discovery_listener_started = False

@app.on_event("startup")
async def start_discovery_listener():
    # Running HTTP:8080 and HTTPS:8443 as two separate uvicorn Server instances against the
    # same app (see __main__ below) means this startup event fires once per server -- guard
    # so the UDP socket, a single process-wide resource, is only bound once. Without this the
    # second server's bind attempt raises OSError (WinError 10048) and startup fails entirely.
    global _discovery_listener_started
    if _discovery_listener_started:
        return
    _discovery_listener_started = True
    loop = asyncio.get_event_loop()
    await loop.create_datagram_endpoint(
        DiscoveryProtocol,
        local_addr=("0.0.0.0", DISCOVERY_PORT),
    )
    print(f"📡 UDP discovery listener active on port {DISCOVERY_PORT} (firmware IP auto-discovery)")

ui_clients = set()
ui_clients_lock = asyncio.Lock()

# --- Multi-station identity ---------------------------------------------------
# Each ESP32 board is a "station", identified by a human-readable name it carries in every
# /update POST (set via USB provisioning -- see the STATION_* serial commands in esp32.ino
# and CLAUDE.md's WiFi provisioning section). A board that never had a name set (old
# firmware, or unprovisioned) omits the field entirely, which normalizes to DEFAULT_STATION
# below -- so a single-board deployment behaves exactly as before with zero configuration.
DEFAULT_STATION = "default"
MAX_STATION_NAME_LEN = 40


def _normalize_station(raw) -> str:
    if not isinstance(raw, str):
        return DEFAULT_STATION
    name = raw.strip()
    if not name:
        return DEFAULT_STATION
    return name[:MAX_STATION_NAME_LEN]


# Running min/max per parameter, tracked since server start (reset on restart), keyed by
# station so two boards' ranges never blend into one. Living on the backend (not
# per-browser) so every connected dashboard shows the same range and it survives page
# refreshes. Mutated only from the event loop in update_sensor, so no lock is needed.
STAT_KEYS = ("temperature", "turbidity", "tds", "flowRate")
sensor_stats: dict[str, dict] = {}

# Edge-detection state for push notifications: last known severity per (station, param), so
# a push fires only on that station's good->warn/danger transition (see
# _check_breaches_and_dispatch below) without one station's recovery masking another's.
last_severity: dict[str, dict] = {}

# In-memory rolling history of recent readings per station so the dashboard's short-window
# graph works live off the sensor stream -- no Google Sheets round-trip. Holds the same
# fields the sheet logs (raw ADC turbidity). Resets on restart; long windows still read from
# the sheet. Created lazily per station on first reading (see _station_history).
HISTORY_BUFFER_MAX = 2000  # ~66 min at a 2s cadence; covers the 5m/15m/1h live windows
history_buffer: dict[str, deque] = {}


def _station_history(station: str) -> deque:
    buf = history_buffer.get(station)
    if buf is None:
        buf = deque(maxlen=HISTORY_BUFFER_MAX)
        history_buffer[station] = buf
    return buf


# Today's cumulative water usage, per station. Kept in-memory as the hot-path value (so the
# quick-view doesn't need a DB round-trip on every 2s reading) and persisted to
# storage.daily_usage fire-and-forget for durability + the Water Usage chart. Seeded from
# storage lazily, the first time each station is seen after a date rollover (including at
# startup), so a restart mid-day doesn't visibly reset usage to 0 -- same "new day, new row"
# reasoning as the storage.py table itself.
def _local_date() -> str:
    return datetime.date.today().isoformat()

_daily_usage_date = _local_date()
_daily_usage_totals: dict[str, float] = {}
_daily_usage_seeded: set[str] = set()


def _add_daily_usage(station: str, liters: float) -> float:
    """Adds `liters` to `station`'s running total for today (rolling every station's
    in-memory total over to a fresh day first if the date has changed since the last
    reading), persists async, and returns the new total."""
    global _daily_usage_date
    today = _local_date()
    if today != _daily_usage_date:
        _daily_usage_date = today
        _daily_usage_totals.clear()
        _daily_usage_seeded.clear()
    if station not in _daily_usage_seeded:
        _daily_usage_totals[station] = storage.get_daily_usage(today, station) if storage.enabled() else 0.0
        _daily_usage_seeded.add(station)
    total = _daily_usage_totals.get(station, 0.0) + liters
    _daily_usage_totals[station] = total
    if storage.enabled():
        asyncio.create_task(asyncio.to_thread(storage.add_daily_usage, today, station, liters))
    return total


def _update_stats(station: str, payload: dict) -> None:
    stats = sensor_stats.setdefault(station, {})
    for key in STAT_KEYS:
        if key not in payload:
            continue
        value = payload[key]
        current = stats.get(key)
        if current is None:
            stats[key] = {"min": value, "max": value}
        else:
            current["min"] = min(current["min"], value)
            current["max"] = max(current["max"], value)


def _stats_snapshot(station: str) -> dict:
    # Deep-ish copy so a snapshot handed to a coroutine/broadcast can't be mutated
    # underneath it by a later reading.
    stats = sensor_stats.get(station, {})
    return {key: dict(stat) for key, stat in stats.items()}


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


async def broadcast_station_renamed(old: str, new: str) -> None:
    disconnected_clients = []
    message = json.dumps({"type": "station_renamed", "old": old, "new": new})
    async with ui_clients_lock:
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


CALIBRATED_SENSORS = ("turbidity", "tds", "flow")


def _default_calibration() -> dict:
    return {
        "turbidity": {"model": "linear2", "points": [], "coefficients": None, "updated": None},
        "tds": {"model": "kfactor", "points": [], "coefficients": {"k": 1.0}, "updated": None},
        # k = pulses per liter. YF-S201 nominal is ~450 (7.5 pulses/sec per L/min * 60s);
        # refined the same way TDS's k is -- pour a known volume through, capture the pulse
        # count, k = counted_pulses / measured_liters.
        "flow": {"model": "kfactor", "points": [], "coefficients": {"k": 450.0}, "updated": None},
    }


def _initial_calibration_mode(calib: dict) -> bool:
    # Defaults ON when a real calibration already exists, so a calibrated station keeps
    # applying after a restart; otherwise OFF.
    return bool(
        calib["turbidity"]["coefficients"]
        or (calib["tds"]["coefficients"] or {}).get("k", 1.0) != 1.0
        or (calib["flow"]["coefficients"] or {}).get("k", 450.0) != 450.0
    )


def _load_calibration() -> dict[str, dict]:
    """Returns {station: calibration_dict}. calibration.json used to be a single flat
    {turbidity:{...}, tds:{...}, flow:{...}} for one implicit station; this migrates that
    old shape (detected by the top-level keys being sensor names directly) by wrapping it
    once under DEFAULT_STATION and writing a one-time backup, since this file is git-ignored
    production data that must never be silently discarded."""
    try:
        with open(CALIBRATION_PATH, encoding="utf-8") as f:
            stored = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    if not isinstance(stored, dict):
        return {}

    if any(key in stored for key in CALIBRATED_SENSORS):
        backup_path = CALIBRATION_PATH + ".bak-premigration"
        if not os.path.exists(backup_path):
            try:
                with open(backup_path, "w", encoding="utf-8") as bf:
                    json.dump(stored, bf, indent=2)
            except OSError as exc:
                print(f"⚠️ Failed to write calibration pre-migration backup: {exc}")
        stored = {DEFAULT_STATION: stored}
        # Persist the migrated shape immediately, not just in memory -- otherwise every
        # restart re-detects the (untouched) old-shape file on disk and re-derives the same
        # migration from scratch, which is harmless but pointless once we already know the
        # answer.
        try:
            with open(CALIBRATION_PATH, "w", encoding="utf-8") as f:
                json.dump(stored, f, indent=2)
            print(f"📦 Migrated {CALIBRATION_PATH} to multi-station shape (backup: {backup_path})")
        except OSError as exc:
            print(f"⚠️ Failed to write migrated {CALIBRATION_PATH}: {exc}")

    result: dict[str, dict] = {}
    for station, raw in stored.items():
        if not isinstance(raw, dict):
            continue
        calib = _default_calibration()
        for sensor in CALIBRATED_SENSORS:
            if isinstance(raw.get(sensor), dict):
                calib[sensor].update(raw[sensor])
        result[station] = calib
    return result


# {station: {turbidity: {...}, tds: {...}, flow: {...}}}. A station not yet in this dict
# (never captured/loaded) is created lazily on first access via _station_calibration.
calibration: dict[str, dict] = _load_calibration()
# {station: bool} -- see _initial_calibration_mode for the ON/OFF default; a not-yet-seen
# station defaults to OFF (matches a brand-new, uncalibrated _default_calibration()).
calibration_mode: dict[str, bool] = {
    station: _initial_calibration_mode(calib) for station, calib in calibration.items()
}


def _station_calibration(station: str) -> dict:
    calib = calibration.get(station)
    if calib is None:
        calib = _default_calibration()
        calibration[station] = calib
    return calib


def _station_calibration_mode(station: str) -> bool:
    return calibration_mode.get(station, False)


# Latest raw reading per station per sensor, plus a short rolling buffer, so a calibration
# "capture" can average out electrical noise instead of grabbing a single instant. Created
# lazily per station on first reading.
latest_raw: dict[str, dict] = {}
_raw_buffers: dict[str, dict] = {}


def _station_latest_raw(station: str) -> dict:
    raw = latest_raw.get(station)
    if raw is None:
        raw = {"turbidity": None, "tdsVoltage": None, "temperature": None, "flowRaw": None}
        latest_raw[station] = raw
    return raw


def _station_raw_buffers(station: str) -> dict:
    bufs = _raw_buffers.get(station)
    if bufs is None:
        bufs = {"turbidity": deque(maxlen=5), "tdsVoltage": deque(maxlen=5), "flowRaw": deque(maxlen=5)}
        _raw_buffers[station] = bufs
    return bufs


def _station_known_in_memory(station: str) -> bool:
    """True if `station` appears in any of the in-memory per-station structures.
    Deliberately checks raw dict membership, NOT the _station_*() accessor functions
    above -- those lazily CREATE an entry on first access, which would make every
    station "exist" the moment you asked about it."""
    return (
        station in history_buffer
        or station in calibration
        or station in sensor_stats
        or station in latest_raw
    )


def _save_calibration() -> None:
    with open(CALIBRATION_PATH, "w", encoding="utf-8") as f:
        json.dump(calibration, f, indent=2)


def _now_iso() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def _recompute_turbidity(station: str) -> None:
    # 2-point linear fit. With >2 points, use the first and last by raw ADC so the line
    # spans the full captured range; a single point can't define a slope.
    calib = _station_calibration(station)
    points = calib["turbidity"]["points"]
    if len(points) < 2:
        calib["turbidity"]["coefficients"] = None
        return
    ordered = sorted(points, key=lambda p: p["raw"])
    p1, p2 = ordered[0], ordered[-1]
    if p2["raw"] == p1["raw"]:
        calib["turbidity"]["coefficients"] = None
        return
    slope = (p2["reference"] - p1["reference"]) / (p2["raw"] - p1["raw"])
    intercept = p1["reference"] - slope * p1["raw"]
    calib["turbidity"]["coefficients"] = {"slope": slope, "intercept": intercept}


def _dfrobot_ppm(voltage: float, temperature_c) -> float:
    # DFRobot TDS Meter V1.0 official formula, temperature-compensated against the DS18B20
    # reading (raw output drifts with water temperature, nominally calibrated at 25C).
    temp = temperature_c if isinstance(temperature_c, (int, float)) else 25.0
    coeff = 1.0 + 0.02 * (temp - 25.0)
    v = voltage / coeff if coeff else voltage
    ppm = (133.42 * v * v * v - 255.86 * v * v + 857.39 * v) * 0.5
    return max(0.0, ppm)


def _recompute_tds(station: str) -> None:
    # Single-point k-factor: k = known_ppm / dfrobot_ppm at the captured voltage/temp.
    calib = _station_calibration(station)
    points = calib["tds"]["points"]
    if not points:
        calib["tds"]["coefficients"] = {"k": 1.0}
        return
    p = points[-1]
    base = _dfrobot_ppm(p["rawVoltage"], p.get("temperature", 25.0))
    k = (p["reference"] / base) if base > 0 else 1.0
    calib["tds"]["coefficients"] = {"k": k}


def apply_turbidity(station: str, adc: float):
    coeffs = _station_calibration(station)["turbidity"]["coefficients"]
    if not coeffs:
        return None
    ntu = coeffs["slope"] * adc + coeffs["intercept"]
    return round(max(0.0, ntu), 1)


def apply_tds(station: str, voltage: float, temperature_c) -> float:
    k = (_station_calibration(station)["tds"]["coefficients"] or {}).get("k", 1.0)
    return round(k * _dfrobot_ppm(voltage, temperature_c), 1)


# The DFRobot polynomial in _dfrobot_ppm is itself the temperature-compensated electrical
# conductivity in uS/cm; the trailing * 0.5 is the standard EC -> TDS(ppm) conversion.
# So EC is not a separate sensor -- it is exactly the TDS reading divided back out by that
# same factor, and it inherits the TDS k-factor calibration so the two always agree.
TDS_TO_EC_FACTOR = 0.5


def ppm_to_ec(ppm) -> float | None:
    if not isinstance(ppm, (int, float)):
        return None
    return round(ppm / TDS_TO_EC_FACTOR, 1)


def _recompute_flow(station: str) -> None:
    # Single-point k-factor, same shape as _recompute_tds: k = counted_pulses / measured
    # liters (pulses per liter), from a "pour a known volume through, capture the pulse
    # count" calibration point.
    calib = _station_calibration(station)
    points = calib["flow"]["points"]
    if not points:
        calib["flow"]["coefficients"] = {"k": 450.0}
        return
    p = points[-1]
    liters = p.get("reference", 0)
    k = (p["rawPulses"] / liters) if liters > 0 else 450.0
    calib["flow"]["coefficients"] = {"k": k}


# Matches the firmware's 2s broadcastInterval -- flowPulses arrives as a raw count over that
# fixed window, same "no elapsed-time bookkeeping" simplicity turbidity/TDS already use.
FLOW_INTERVAL_SECONDS = 2.0


def apply_flow(station: str, pulses: float) -> tuple[float, float]:
    """Returns (litersThisInterval, flowRateLpm) from a raw pulse count. Only applies the
    saved k-factor when calibration mode is ON (mirrors apply_tds); OFF uses the nominal
    YF-S201 default so an unconfigured/miscalibrated k can't silently skew the live reading."""
    mode = _station_calibration_mode(station)
    k = (_station_calibration(station)["flow"]["coefficients"] or {}).get("k", 450.0) if mode else 450.0
    if not k:
        return 0.0, 0.0
    liters = pulses / k
    rate_lpm = liters * (60.0 / FLOW_INTERVAL_SECONDS)
    return round(liters, 4), round(rate_lpm, 2)


# --- Push notifications -------------------------------------------------------
# Breach detection runs synchronously/inline on every reading (edge-triggered good->warn/
# danger transition tracked in last_severity, so out-of-order dispatch can't corrupt it);
# the actual network sends are deferred via asyncio.create_task, the same fire-and-forget
# pattern already used for the Sheets relay and local DB insert in update_sensor.

PUSH_PARAMS = ("temperature", "turbidity", "tds", "ec")

# Display metadata (emoji, label, unit) for push notification text. Hand-mirrored from
# frontend/src/lib/paramMeta.ts's labels/units, same as thresholds.py mirrors RANGE_BANDS --
# nothing enforces the two staying in sync.
PARAM_DISPLAY = {
    "temperature": ("🌡️", "Temperature", "°C"),
    "turbidity": ("💧", "Turbidity", "NTU"),
    "tds": ("🧪", "TDS", "ppm"),
    "ec": ("⚡", "EC", "µS/cm"),
}


def _check_breaches_and_dispatch(station: str, payload: dict) -> list:
    breaches = []
    station_severity = last_severity.setdefault(station, {})
    for param in PUSH_PARAMS:
        value = payload.get(param)
        if not isinstance(value, (int, float)):
            continue
        if thresholds.is_sensor_fault(param, value):
            continue
        status = thresholds.range_status_for(param, value)
        prev = station_severity.get(param, "good")
        if status in ("warn", "danger") and prev == "good":
            breaches.append((param, status))
        station_severity[param] = status
    return breaches


def _format_push_text(param: str, severity: str, value) -> tuple:
    emoji, label, unit = PARAM_DISPLAY.get(param, ("⚠️", param.capitalize(), ""))
    title = f"{emoji} {label} — {severity.title()}"
    try:
        formatted_value = f"{float(value):.1f}"
    except (TypeError, ValueError):
        formatted_value = str(value)
    body = f"{formatted_value} {unit} is in the {severity} range".strip()
    return title, body


def _push_payload(title: str, body: str, tag: str) -> str:
    return json.dumps(
        {
            "title": title,
            "body": body,
            "tag": tag,
            "icon": "/favicon.svg",
            "badge": "/favicon.svg",
            "actions": [
                {"action": "view", "title": "View Dashboard"},
                {"action": "dismiss", "title": "Dismiss"},
            ],
        }
    )


def _send_one_push(sub: dict, title: str, body: str, param: str, severity: str) -> None:
    subscription_info = {
        "endpoint": sub["endpoint"],
        "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
    }
    try:
        webpush(
            subscription_info=subscription_info,
            data=_push_payload(title, body, f"{param}-{severity}"),
            vapid_private_key=VAPID_PRIVATE_KEY_FILE,
            vapid_claims={"sub": VAPID_CLAIM_SUB},
        )
    except WebPushException as e:
        if e.response is not None and e.response.status_code in (404, 410):
            storage.delete_push_subscription(sub["endpoint"])
        else:
            print(f"⚠️ Push send failed for {sub['endpoint']}: {e}")
    except Exception as exc:
        print(f"⚠️ Push send failed for {sub['endpoint']}: {exc}")


async def dispatch_push_breaches(breaches: list, payload: dict) -> None:
    if not breaches or not vapid_available():
        return
    subs = await asyncio.to_thread(storage.get_all_push_subscriptions)
    for param, severity in breaches:
        value = payload.get(param)
        title, body = _format_push_text(param, severity, value)
        for sub in subs:
            if sub["prefs"].get(param, {}).get(severity, False):
                await asyncio.to_thread(_send_one_push, sub, title, body, param, severity)


# Same auth as /update (see its check below), factored out so both routes enforce it
# identically -- a health check that skipped auth would "pass" against a backend whose real
# /update then rejects the board, which is exactly the failure this endpoint exists to catch.
def _check_update_api_key(request: Request) -> bool:
    return not UPDATE_API_KEY or hmac.compare_digest(request.headers.get("x-api-key", ""), UPDATE_API_KEY)


@app.get("/update/health")
async def update_health(request: Request):
    # Dedicated no-op reachability/auth check for BACKEND_TEST (esp32.ino) / the WiFi panel's
    # "Test connection" button, so verifying the fixed-backend-host override doesn't write a
    # fake sensor reading into history/Sheets/push-notification thresholds the way a real
    # /update POST would.
    if not _check_update_api_key(request):
        return JSONResponse({"error": "invalid or missing X-API-Key"}, status_code=401)
    return JSONResponse({"ok": True})


@app.post("/update")
async def update_sensor(request: Request):
    # Checked only when UPDATE_API_KEY is configured (see its definition above) -- keeps every
    # same-LAN-only setup working unauthenticated exactly as before. constant_time comparison
    # since this is a secret comparison over a network-reachable endpoint.
    if not _check_update_api_key(request):
        return JSONResponse({"error": "invalid or missing X-API-Key"}, status_code=401)
    try:
        data = await request.json()
        # See DEFAULT_STATION above: a board that never had a name provisioned (old
        # firmware, or a fresh unprovisioned board) omits `station` entirely, and normalizes
        # to the same single implicit station every prior version of this app had.
        station = _normalize_station(data.get("station"))
        payload = {
            "source": "arduino",
            "timestamp": int(time.time()),
            "station": station,
        }

        if "temperature" in data and "turbidity" in data:
            payload["temperature"] = float(data["temperature"])
            # Turbidity arrives as the averaged raw ADC and is kept in `turbidity` (both
            # dashboards read that key). The calibrated NTU rides along in `turbidityNtu`
            # when a turbidity calibration is active (else None).
            turbidity_adc = float(data["turbidity"])
            # Only apply this station's saved calibration when calibration mode is ON (the
            # Calibration tab's on/off button). OFF => ntu stays None => dashboard shows raw ADC.
            station_mode = _station_calibration_mode(station)
            ntu = apply_turbidity(station, turbidity_adc) if station_mode else None
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
            raw = _station_latest_raw(station)
            raw["turbidity"] = turbidity_adc
            _station_raw_buffers(station)["turbidity"].append(turbidity_adc)

            raw["temperature"] = payload["temperature"]

            # TDS: prefer the raw voltage from current firmware (backend computes ppm via
            # calibration). Fall back to a legacy pre-computed `tds` ppm from an un-reflashed
            # board so the old firmware keeps working (backward-compatible contract).
            if "tdsVoltage" in data:
                tds_voltage = float(data["tdsVoltage"])
                payload["tdsVoltage"] = tds_voltage
                # Apply the k-factor only when calibration mode is ON; OFF => uncalibrated
                # DFRobot ppm (k = 1.0).
                payload["tds"] = (
                    apply_tds(station, tds_voltage, payload["temperature"])
                    if station_mode
                    else round(_dfrobot_ppm(tds_voltage, payload["temperature"]), 1)
                )
                raw["tdsVoltage"] = tds_voltage
                _station_raw_buffers(station)["tdsVoltage"].append(tds_voltage)
            elif "tds" in data:
                payload["tds"] = float(data["tds"])

            # EC is derived from the same measurement as TDS (see ppm_to_ec) -- emitted as
            # its own field so dashboards don't each re-derive the conversion factor.
            ec = ppm_to_ec(payload.get("tds"))
            if ec is not None:
                payload["ec"] = ec

            # Flow sensor: firmware sends the raw pulse count accumulated over the last
            # FLOW_INTERVAL_SECONDS (a hall-effect pulse counter, unlike the other analog
            # sensors). No thresholds/calibration-mode-off fallback beyond apply_flow's own
            # gating -- flow rate/usage are plain quantities, not water-quality judgments.
            if "flowPulses" in data:
                flow_pulses = float(data["flowPulses"])
                liters, flow_rate = apply_flow(station, flow_pulses)
                payload["flowRate"] = flow_rate
                payload["waterUsageToday"] = round(_add_daily_usage(station, liters), 4)
                raw["flowRaw"] = flow_pulses
                _station_raw_buffers(station)["flowRaw"].append(flow_pulses)
        else:
            text = await request.body()
            if not text:
                return JSONResponse({"error": "missing body"}, status_code=400)

            parsed = parse_qs(text.decode("utf-8", errors="ignore"), keep_blank_values=True)
            water_level = parsed.get("water_level", [None])[0]
            if water_level is None:
                return JSONResponse({"error": "missing water_level"}, status_code=400)

            payload["water_level"] = int(float(water_level))

        _update_stats(station, payload)
        payload["stats"] = _stats_snapshot(station)

        print(f"Received sensor update: {payload}")
        await broadcast_sensor_update(payload)
        if "temperature" in payload:
            # Record into this station's in-memory rolling history for the live short-window
            # graph (same raw ADC turbidity the sheet logs; timestamp in epoch ms to match it).
            history_row = {
                "timestamp": payload["timestamp"] * 1000,
                "station": station,
                "temperature": payload["temperature"],
                "turbidity": payload.get("turbidityRaw", payload.get("turbidity")),
                "tds": payload.get("tds"),
                "ec": payload.get("ec"),
                "flowRate": payload.get("flowRate"),
            }
            _station_history(station).append(history_row)

            # Google Sheets keeps logging the raw averaged turbidity ADC (its column header is
            # "Turbidity (raw ADC)"), independent of what unit the dashboards display.
            sheet_payload = {
                "source": payload["source"],
                "timestamp": payload["timestamp"],
                "station": station,
                "temperature": payload["temperature"],
                "turbidity": payload.get("turbidityRaw", payload["turbidity"]),
            }
            if "tds" in payload:
                sheet_payload["tds"] = payload["tds"]
            # Instantaneous flow rate only -- water usage (the daily cumulative total) is a
            # different shape/cadence (see storage.py's daily_usage table) that doesn't fit
            # this per-reading log, same reasoning google_apps_script.gs's insertReadingAtTop_
            # documents for its Flow Rate column.
            if "flowRate" in payload:
                sheet_payload["flowRate"] = payload["flowRate"]
            asyncio.create_task(relay_to_google_sheets(sheet_payload))

            # Threshold-breach push notifications: detection is synchronous/inline (must
            # observe every reading in order to edge-detect correctly), the actual sends
            # are deferred like the two tasks above.
            breaches = _check_breaches_and_dispatch(station, payload)
            if breaches:
                asyncio.create_task(dispatch_push_breaches(breaches, payload))
        return JSONResponse({"ok": True, "payload": payload})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)


# Selectable history windows for the dashboard graph (label -> seconds). Default 15m.
HISTORY_WINDOWS = {
    "5m": 5 * 60,
    "15m": 15 * 60,
    "1h": 60 * 60,
    "3h": 3 * 60 * 60,
    "12h": 12 * 60 * 60,
    "24h": 24 * 60 * 60,
}
HISTORY_DEFAULT_WINDOW = "15m"
HISTORY_MAX_POINTS = 400  # downsample target so long windows stay small/fast
# How far after a window's cutoff the oldest local row may sit while still counting as full
# coverage. Readings arrive every 2s, so the first row at/after a cutoff is essentially
# always a second or two late; without this tolerance every single request would look like a
# coverage gap and trigger a pointless multi-second Google Sheets round-trip.
HISTORY_GAP_TOLERANCE_MS = 15_000


def _downsample(rows: list, max_points: int) -> list:
    if len(rows) <= max_points:
        return rows
    stride = (len(rows) + max_points - 1) // max_points
    return rows[::stride]


def _with_ntu(station: str, rows: list) -> list:
    # Each row's `turbidity` is raw ADC (matching the sheet). Add `turbidityNtu` = calibrated
    # NTU (or None if uncalibrated) so the dashboard stays consistent with the live WS value,
    # while `turbidity` keeps carrying the raw ADC.
    out = []
    for r in rows:
        adc = r.get("turbidity")
        ntu = apply_turbidity(station, adc) if isinstance(adc, (int, float)) else None
        # Sheet-backed rows (long windows) have no `ec` column -- derive it from tds so the
        # EC graph works across every window, not just the live in-memory ones.
        ec = r.get("ec")
        if ec is None:
            ec = ppm_to_ec(r.get("tds"))
        # Sheets rows carry flowRate once google_apps_script.gs has been redeployed with its
        # Flow Rate column (see CLAUDE.md); rows logged before that redeploy, or buffer rows
        # where a reading simply had no flow data, fall back to None here uniformly.
        flow_rate = r.get("flowRate")
        out.append({**r, "station": station, "turbidityNtu": ntu, "ec": ec, "flowRate": flow_rate})
    return out


async def _fetch_sheet_rows(
    seconds: int, cutoff_ms: float, max_points: int, station: str
) -> tuple[list, str | None]:
    # Ask the Apps Script for this window + a downsample cap (it strides rows to fit).
    # Shared by the long-window path and the short-window buffer-gap fallback below.
    # `station` is forwarded so doGet can filter by it once google_apps_script.gs's Station
    # column lands (see CLAUDE.md) -- until then the Apps Script side just ignores the param
    # and returns every station's rows undifferentiated, same as before this field existed.
    sep = "&" if "?" in GOOGLE_SHEETS_WEBHOOK_URL else "?"
    url = GOOGLE_SHEETS_WEBHOOK_URL + sep + urlencode(
        {"seconds": seconds, "maxPoints": max_points, "station": station}
    )

    def fetch() -> str:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8")

    try:
        raw = await asyncio.to_thread(fetch)
        data = json.loads(raw)
    except Exception as exc:
        print(f"⚠️ Failed to read history from Google Sheets: {exc}")
        return [], str(exc)

    rows = [
        r
        for r in data.get("rows", [])
        if isinstance(r.get("timestamp"), (int, float)) and r["timestamp"] >= cutoff_ms
    ]
    return rows, None


@app.get("/history")
async def get_history(window: str = HISTORY_DEFAULT_WINDOW, station: str = DEFAULT_STATION):
    """Readings for the requested station+window, newest-last, from the cheapest source
    that covers it.

    Two tiers, in order:
      1. the in-memory buffer -- answers instantly for anything still in the rolling window;
      2. Google Sheets -- consulted only for the part of the window the buffer doesn't reach
         (a fresh restart, or a window longer than the buffer holds). Proxied here so the
         dashboard's fetch stays same-origin.
    """
    station = _normalize_station(station)
    seconds = HISTORY_WINDOWS.get(window)
    if seconds is None:
        return JSONResponse(
            {"error": f"invalid window '{window}'; allowed: {', '.join(HISTORY_WINDOWS)}"},
            status_code=400,
        )

    cutoff_ms = (time.time() - seconds) * 1000
    sources: list[str] = []

    # Tier 1 -- in-memory buffer, the whole live path (wiped on restart).
    buffer = history_buffer.get(station, ())
    rows = [r for r in buffer if r["timestamp"] >= cutoff_ms]
    if rows:
        sources.append("live")

    # Tier 2 -- Sheets fills the older end when the buffer starts too late. The tolerance
    # keeps a normal steady-state request (oldest row a second or two after the cutoff) from
    # counting as a gap; see HISTORY_GAP_TOLERANCE_MS.
    local_floor_ms = rows[0]["timestamp"] if rows else float("inf")
    coverage_gap = (not rows) or (local_floor_ms > cutoff_ms + HISTORY_GAP_TOLERANCE_MS)

    if coverage_gap and GOOGLE_SHEETS_WEBHOOK_URL:
        sheet_rows, err = await _fetch_sheet_rows(seconds, cutoff_ms, HISTORY_MAX_POINTS, station)
        # Keep only rows strictly older than what the buffer already covers, so the merge
        # has no duplicate/overlapping rows at the seam.
        sheet_rows = [r for r in sheet_rows if r["timestamp"] < local_floor_ms]
        if sheet_rows:
            rows = sheet_rows + rows  # both chronological ascending -> merge stays ordered
            sources.append("sheet")
        if err is not None and not rows:
            return JSONResponse(
                {"rows": [], "windowSeconds": seconds, "error": err, "source": "sheet"}
            )

    return JSONResponse({
        "rows": _with_ntu(station, _downsample(rows, HISTORY_MAX_POINTS)),
        "windowSeconds": seconds,
        "source": "+".join(sources) if sources else "none",
    })


# --- Calibration API ---------------------------------------------------------
# Drives the frontend's Calibration tab. State lives in the `calibration` dict and is
# only persisted to calibration.json on an explicit save, so captures can be reviewed
# (and discarded) before they take effect on the live stream.


def _avg_raw(station: str, key: str):
    buf = _station_raw_buffers(station).get(key)
    if buf:
        return sum(buf) / len(buf)
    return _station_latest_raw(station).get(key)


@app.get("/calibration")
async def get_calibration(station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    calib = _station_calibration(station)
    raw = _station_latest_raw(station)
    return JSONResponse(
        {
            "mode": _station_calibration_mode(station),
            "turbidity": calib["turbidity"],
            "tds": calib["tds"],
            "flow": calib["flow"],
            "latestRaw": {
                "turbidity": raw["turbidity"],
                "tdsVoltage": raw["tdsVoltage"],
                "temperature": raw["temperature"],
                "flowRaw": raw["flowRaw"],
            },
        }
    )


@app.post("/calibration/mode")
async def set_calibration_mode(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    calibration_mode[station] = bool(body.get("enabled"))
    return JSONResponse({"mode": calibration_mode[station]})


_RECOMPUTE_FNS = {
    "turbidity": _recompute_turbidity,
    "tds": _recompute_tds,
    "flow": _recompute_flow,
}


@app.post("/calibration/capture")
async def capture_calibration_point(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in CALIBRATED_SENSORS:
        return JSONResponse({"error": "sensor must be 'turbidity', 'tds', or 'flow'"}, status_code=400)
    try:
        reference = float(body["reference"])
    except (KeyError, TypeError, ValueError):
        return JSONResponse({"error": "reference (numeric) is required"}, status_code=400)
    label = str(body.get("label", ""))

    # Raw value: use the user-typed `raw` when provided (manual entry -- type the ADC/voltage/
    # pulse-count and the reference it maps to), otherwise fall back to the averaged live
    # reading. For flow this fallback is a weaker signal than turbidity/tds's -- it averages
    # recent per-interval pulse counts rather than a true total-pulses-over-the-test-pour, so
    # manual entry is the primary path for flow calibration in practice.
    raw_key = {"turbidity": "turbidity", "tds": "tdsVoltage", "flow": "flowRaw"}[sensor]
    manual_raw = body.get("raw")
    if manual_raw is not None and manual_raw != "":
        try:
            raw = float(manual_raw)
        except (TypeError, ValueError):
            return JSONResponse({"error": "raw must be numeric"}, status_code=400)
    else:
        raw = _avg_raw(station, raw_key)
        if raw is None:
            unit = {"turbidity": "Raw ADC", "tds": "Raw V", "flow": "pulse count"}[sensor]
            return JSONResponse(
                {"error": f"no live {sensor} reading yet — type a {unit} value instead"},
                status_code=409,
            )

    calib = _station_calibration(station)
    latest = _station_latest_raw(station)
    if sensor == "turbidity":
        calib["turbidity"]["points"].append(
            {"raw": round(raw, 1), "reference": reference, "label": label}
        )
    elif sensor == "tds":
        calib["tds"]["points"].append(
            {
                "rawVoltage": round(raw, 4),
                "reference": reference,
                "label": label,
                "temperature": latest["temperature"] if latest["temperature"] is not None else 25.0,
            }
        )
    else:
        calib["flow"]["points"].append(
            {"rawPulses": round(raw, 1), "reference": reference, "label": label}
        )
    _RECOMPUTE_FNS[sensor](station)

    return JSONResponse({sensor: calib[sensor]})


@app.delete("/calibration/point")
async def delete_calibration_point(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in CALIBRATED_SENSORS:
        return JSONResponse({"error": "sensor must be 'turbidity', 'tds', or 'flow'"}, status_code=400)
    calib = _station_calibration(station)
    try:
        index = int(body["index"])
        calib[sensor]["points"].pop(index)
    except (KeyError, TypeError, ValueError, IndexError):
        return JSONResponse({"error": "valid point index required"}, status_code=400)
    _RECOMPUTE_FNS[sensor](station)
    return JSONResponse({sensor: calib[sensor]})


@app.post("/calibration/save")
async def save_calibration(station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    calib = _station_calibration(station)
    now = _now_iso()
    for sensor in CALIBRATED_SENSORS:
        calib[sensor]["updated"] = now
    try:
        _save_calibration()
    except OSError as exc:
        return JSONResponse({"error": f"failed to write {CALIBRATION_PATH}: {exc}"}, status_code=500)
    print(f"💾 Calibration saved to {CALIBRATION_PATH} (station={station!r})")
    return JSONResponse({"ok": True, **{s: calib[s] for s in CALIBRATED_SENSORS}})


@app.post("/calibration/reset")
async def reset_calibration(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in CALIBRATED_SENSORS:
        return JSONResponse({"error": "sensor must be 'turbidity', 'tds', or 'flow'"}, status_code=400)
    calib = _station_calibration(station)
    calib[sensor] = _default_calibration()[sensor]
    return JSONResponse({sensor: calib[sensor]})


# --- Flow sensor API ----------------------------------------------------------
# Separate from /history: daily usage is one row per calendar day (storage.daily_usage),
# a different shape/cadence than live readings, so it needs its own small endpoints rather
# than riding the /history buffer+Sheets merge (see storage.py's daily_usage table docstring).


@app.get("/flow/usage")
async def get_flow_usage(days: int = 14, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    today = _local_date()
    if not storage.enabled():
        return JSONResponse({"today": round(_daily_usage_totals.get(station, 0.0), 4), "days": []})
    days = max(1, min(days, 365))
    rows = await asyncio.to_thread(storage.get_recent_daily_usage, station, days)
    # Seed lazily the same way _add_daily_usage does, so a station that's never posted a
    # flow reading this run (but has stored history) still reports today's real total.
    if station not in _daily_usage_seeded:
        _daily_usage_totals[station] = await asyncio.to_thread(storage.get_daily_usage, today, station)
        _daily_usage_seeded.add(station)
    return JSONResponse({"today": round(_daily_usage_totals.get(station, 0.0), 4), "days": rows})


@app.post("/flow/reset-today")
async def reset_flow_usage_today(station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    _daily_usage_totals[station] = 0.0
    _daily_usage_seeded.add(station)
    if storage.enabled():
        await asyncio.to_thread(storage.reset_daily_usage, _local_date(), station)
    return JSONResponse({"ok": True, "today": 0.0})


@app.post("/station/rename")
async def rename_station(request: Request):
    body = await request.json()
    old = _normalize_station(body.get("old"))
    new_raw = body.get("new")
    if not isinstance(new_raw, str) or not new_raw.strip():
        return JSONResponse({"error": "new station name is required"}, status_code=400)
    new = _normalize_station(new_raw)
    if new == DEFAULT_STATION and old != DEFAULT_STATION:
        return JSONResponse(
            {"error": f'cannot rename to the reserved name "{DEFAULT_STATION}"'}, status_code=400
        )
    if old == new:
        return JSONResponse({"error": "new name must differ from the current name"}, status_code=400)

    old_exists = _station_known_in_memory(old) or (
        storage.enabled() and await asyncio.to_thread(storage.station_has_usage, old)
    )
    if not old_exists:
        return JSONResponse({"error": f'station "{old}" not found'}, status_code=404)

    new_exists = _station_known_in_memory(new) or (
        storage.enabled() and await asyncio.to_thread(storage.station_has_usage, new)
    )
    if new_exists:
        return JSONResponse({"error": f'station "{new}" already exists'}, status_code=409)

    def move(mapping: dict, old_key: str, new_key: str) -> None:
        if old_key in mapping:
            mapping[new_key] = mapping.pop(old_key)

    move(history_buffer, old, new)
    move(sensor_stats, old, new)
    move(last_severity, old, new)
    move(calibration, old, new)
    move(calibration_mode, old, new)
    move(latest_raw, old, new)
    move(_raw_buffers, old, new)
    move(_daily_usage_totals, old, new)
    if old in _daily_usage_seeded:
        _daily_usage_seeded.discard(old)
        _daily_usage_seeded.add(new)

    if storage.enabled():
        await asyncio.to_thread(storage.rename_station_usage, old, new)

    if new in calibration:
        try:
            _save_calibration()
        except OSError as exc:
            print(f"⚠️ Failed to persist calibration.json after renaming station: {exc}")

    await broadcast_station_renamed(old, new)

    print(f"✏️ Renamed station {old!r} -> {new!r}")
    return JSONResponse({"old": old, "new": new})


# --- WiFi provisioning API -----------------------------------------------------
# A SEPARATE channel from every other endpoint in this file: these talk to the ESP32 over its
# USB-serial port (wifi_serial.py), not HTTP-over-WiFi, because the whole point is
# reconfiguring WiFi credentials at a moment the ESP32 may not have working WiFi yet. See the
# "Push notifications"-style degrade-gracefully posture -- a missing/unplugged board 503s with
# a clear reason rather than crashing or hanging. No authentication, same as every other
# endpoint in this app (there is no login system anywhere in this codebase) -- worth naming
# explicitly since this one accepts a WiFi password, but not a new gap this feature introduces.


@app.get("/wifi/status")
async def get_wifi_status():
    result = await asyncio.to_thread(wifi_serial.get_status)
    if not result["ok"]:
        return JSONResponse({"error": result["error"]}, status_code=503)
    return JSONResponse(result)


@app.post("/wifi/scan")
async def scan_wifi():
    result = await asyncio.to_thread(wifi_serial.scan_networks)
    if not result["ok"]:
        return JSONResponse({"error": result["error"]}, status_code=503)
    return JSONResponse(result)


@app.post("/wifi/connect")
async def connect_wifi(request: Request):
    body = await request.json()
    ssid = body.get("ssid")
    password = body.get("password")
    if not ssid or password is None:
        return JSONResponse({"error": "ssid and password are required"}, status_code=400)
    result = await asyncio.to_thread(wifi_serial.set_wifi, ssid, password)
    if not result["ok"]:
        return JSONResponse({"error": result["error"]}, status_code=503)
    return JSONResponse(result)


# Same-LAN UDP discovery (see main.py's DiscoveryProtocol / esp32.ino's discoverBackend())
# only ever finds a backend on the board's own subnet. These let the dashboard point the board
# at a backend on a DIFFERENT network instead (over the same USB-serial provisioning channel
# as /wifi/*, since that's the only channel guaranteed to reach the board) -- the target host
# still has to be reachable from wherever the board's WiFi network is (port-forward + DDNS,
# a VPN/tunnel, etc.); this only configures which address the board tries.
@app.get("/wifi/backend")
async def get_wifi_backend():
    result = await asyncio.to_thread(wifi_serial.get_backend_status)
    if not result["ok"]:
        return JSONResponse({"error": result["error"]}, status_code=503)
    return JSONResponse(result)


@app.post("/wifi/backend")
async def set_wifi_backend(request: Request):
    body = await request.json()
    host = body.get("host", "")
    api_key = body.get("apiKey", "")
    use_https = bool(body.get("useHttps", False))
    result = await asyncio.to_thread(wifi_serial.set_backend_host, host, api_key, use_https)
    if not result["ok"]:
        return JSONResponse({"error": result["error"]}, status_code=503)
    return JSONResponse(result)


@app.post("/wifi/backend/test")
async def test_wifi_backend():
    # Has the ESP32 itself round-trip GET /update/health against whatever it's currently
    # configured to use (BACKEND_TEST in esp32.ino) -- exercises the exact path/TLS
    # trust/API-key combination the board's real /update POSTs will use, which a test run
    # from this backend process couldn't (this backend isn't the one whose DNS/routing/NAT
    # path to the target host is in question -- the board's is).
    result = await asyncio.to_thread(wifi_serial.test_backend_connection)
    if not result["ok"]:
        return JSONResponse({"error": result["error"]}, status_code=503)
    return JSONResponse(result)


# --- Push notification API ---------------------------------------------------
# Subscriptions are persisted to push_subscriptions (storage.py) so they survive restarts;
# without local storage enabled there is nowhere to durably keep them, so these all 503.


@app.get("/push/vapid-public-key")
async def get_vapid_public_key():
    if not vapid_available():
        return JSONResponse({"error": "VAPID not configured"}, status_code=503)
    return JSONResponse({"publicKey": VAPID_PUBLIC_KEY})


@app.post("/push/subscribe")
async def push_subscribe(request: Request):
    if not storage.enabled():
        return JSONResponse({"error": "push subscriptions require local storage to be enabled"}, status_code=503)
    body = await request.json()
    endpoint = body.get("endpoint")
    keys = body.get("keys") or {}
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")
    if not endpoint or not p256dh or not auth:
        return JSONResponse({"error": "endpoint and keys.p256dh/keys.auth are required"}, status_code=400)
    prefs = body.get("prefs") or {p: {"warn": False, "danger": True} for p in PUSH_PARAMS}
    await asyncio.to_thread(storage.upsert_push_subscription, endpoint, p256dh, auth, prefs)
    return JSONResponse({"ok": True})


@app.post("/push/unsubscribe")
async def push_unsubscribe(request: Request):
    if not storage.enabled():
        return JSONResponse({"error": "push subscriptions require local storage to be enabled"}, status_code=503)
    body = await request.json()
    endpoint = body.get("endpoint")
    if not endpoint:
        return JSONResponse({"error": "endpoint is required"}, status_code=400)
    await asyncio.to_thread(storage.delete_push_subscription, endpoint)
    return JSONResponse({"ok": True})


@app.get("/push/preferences")
async def get_push_preferences(endpoint: str):
    if not storage.enabled():
        return JSONResponse({"error": "push subscriptions require local storage to be enabled"}, status_code=503)
    subs = await asyncio.to_thread(storage.get_all_push_subscriptions)
    for sub in subs:
        if sub["endpoint"] == endpoint:
            return JSONResponse({"prefs": sub["prefs"]})
    return JSONResponse({"error": "subscription not found"}, status_code=404)


@app.post("/push/test")
async def push_test(request: Request):
    """Sends one real push to a single subscription immediately, bypassing prefs/thresholds
    entirely -- lets the notification-settings UI offer a "send test" button so a user can see
    what the popup looks like on their device without waiting for a real sensor breach."""
    if not vapid_available():
        return JSONResponse({"error": "VAPID not configured"}, status_code=503)
    if not storage.enabled():
        return JSONResponse({"error": "push subscriptions require local storage to be enabled"}, status_code=503)
    body = await request.json()
    endpoint = body.get("endpoint")
    if not endpoint:
        return JSONResponse({"error": "endpoint is required"}, status_code=400)
    subs = await asyncio.to_thread(storage.get_all_push_subscriptions)
    sub = next((s for s in subs if s["endpoint"] == endpoint), None)
    if sub is None:
        return JSONResponse({"error": "subscription not found"}, status_code=404)

    subscription_info = {
        "endpoint": sub["endpoint"],
        "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
    }

    def _send() -> tuple:
        try:
            webpush(
                subscription_info=subscription_info,
                data=_push_payload(
                    "🔔 HydroMonitor — Test",
                    "This is a test notification. If you can see this, alerts are working.",
                    "test",
                ),
                vapid_private_key=VAPID_PRIVATE_KEY_FILE,
                vapid_claims={"sub": VAPID_CLAIM_SUB},
            )
            return True, None
        except WebPushException as e:
            if e.response is not None and e.response.status_code in (404, 410):
                storage.delete_push_subscription(sub["endpoint"])
                return False, "subscription is no longer valid and has been removed"
            return False, str(e)
        except Exception as exc:
            return False, str(exc)

    ok, error = await asyncio.to_thread(_send)
    if not ok:
        return JSONResponse({"error": error}, status_code=502)
    return JSONResponse({"ok": True})


@app.put("/push/preferences")
async def put_push_preferences(request: Request):
    if not storage.enabled():
        return JSONResponse({"error": "push subscriptions require local storage to be enabled"}, status_code=503)
    body = await request.json()
    endpoint = body.get("endpoint")
    prefs = body.get("prefs")
    if not endpoint or prefs is None:
        return JSONResponse({"error": "endpoint and prefs are required"}, status_code=400)
    ok = await asyncio.to_thread(storage.update_push_prefs, endpoint, prefs)
    if not ok:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse({"ok": True})


@app.websocket("/ws/app")
async def websocket_app(websocket: WebSocket):
    await websocket.accept()
    print("🖥️ Web UI connected to /ws/app")

    async with ui_clients_lock:
        ui_clients.add(websocket)

    # Always prime the freshly connected dashboard -- even with nothing recorded yet.
    # Previously this only fired when sensor_stats was non-empty, so a dashboard opened
    # before the first ESP32 push got *zero* frames and could not tell "no record yet"
    # from a hung socket. The prime always carries `hasData`, so the UI can render an
    # explicit empty state instead of fabricating numbers.
    #
    # Multi-station: one prime frame is sent PER known station that has data, each carrying
    # its own `station` field, so a dashboard connecting mid-run sees every station's latest
    # reading immediately rather than only whichever one posted last. If no station has any
    # data yet, a single hasData:false frame is sent instead (same shape as before stations
    # existed), so a completely fresh system still gets an explicit empty state.
    stations_with_data = [s for s, buf in history_buffer.items() if buf]

    if not stations_with_data:
        try:
            await websocket.send_text(json.dumps({
                "type": "sensor_update",
                "payload": {"stats": None, "hasData": False, "lastTimestamp": None},
            }))
        except Exception:
            pass
    else:
        for station in stations_with_data:
            last = history_buffer[station][-1]
            # history_buffer always stores turbidity as the RAW averaged ADC. Re-derive the
            # displayed value/unit exactly the way /update does so the prime and the live
            # broadcasts agree.
            turbidity_adc = last.get("turbidity")
            station_mode = _station_calibration_mode(station)
            ntu = (
                apply_turbidity(station, turbidity_adc)
                if (station_mode and turbidity_adc is not None)
                else None
            )
            prime_payload = {
                "stats": _stats_snapshot(station) or None,
                "hasData": True,
                # SECONDS (epoch), matching the WS `timestamp` convention used by /update.
                # NOTE: history_buffer rows store epoch MILLISECONDS (to match the /history
                # / Google Sheets rows), hence the // 1000 below.
                "lastTimestamp": last["timestamp"] // 1000,
                "source": "prime",
                "station": station,
                "timestamp": last["timestamp"] // 1000,
                "temperature": last.get("temperature"),
                "turbidityRaw": turbidity_adc,
                "turbidityNtu": ntu,
                "turbidity": ntu if ntu is not None else turbidity_adc,
                "turbidityUnit": "NTU" if ntu is not None else "ADC",
                "tds": last.get("tds"),
            }
            try:
                await websocket.send_text(
                    json.dumps({"type": "sensor_update", "payload": prime_payload})
                )
            except Exception:
                break

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        print("📴 Web UI disconnected from /ws/app")
    finally:
        async with ui_clients_lock:
            ui_clients.discard(websocket)


# The Aqua Monitor React app (frontend/) is the default page, mounted at "/" LAST so it
# only catches requests that no explicit route above already matched (Starlette tries
# routes in registration order; specific routes like /history, /calibration, /ws/app all win
# over this root Mount since they were registered earlier). StaticFiles(html=True) serves
# frontend/dist/index.html for "/" and transparently serves every nested file the built app
# needs (favicon.svg, icons.svg, assets/*.js/css) with no separate /assets mount required.
if os.path.isdir("frontend/dist"):
    app.mount("/", SpaStaticFiles(directory="frontend/dist", html=True), name="aquamonitor")
    print("✅ Mounted Aqua Monitor React app as the default page at /.")
else:
    print("⚠️ frontend/dist not found; default page disabled (run: cd frontend && npm run build).")


if __name__ == "__main__":
    import uvicorn

    # The autoreloader is DEV-ONLY, opt-in via HYDRO_DEV=1. It must stay off in a real
    # deployment: it watches the working directory, so every calibration save (which writes
    # calibration.json here) and every history.db write would restart the server -- dropping
    # all dashboard WebSockets and wiping history_buffer/sensor_stats each time. It also runs
    # a supervisor + child process, which double-binds the UDP discovery port on restart.
    dev_mode = os.getenv("HYDRO_DEV") == "1"
    if dev_mode:
        print("🔧 HYDRO_DEV=1 -- autoreload ON (development only).")

    async def _run_servers():
        # HTTP:8080 always runs (unchanged -- ESP32 firmware keeps POSTing here). HTTPS is
        # additive: only started when both a cert and key are configured and present on disk,
        # since Web Push requires a secure context and http://localhost is only exempt on the
        # same machine.
        configs = [uvicorn.Config("main:app", host="0.0.0.0", port=8080, reload=dev_mode)]
        if https_enabled():
            configs.append(
                uvicorn.Config(
                    "main:app",
                    host="0.0.0.0",
                    port=HTTPS_PORT,
                    ssl_certfile=HTTPS_CERT_FILE,
                    ssl_keyfile=HTTPS_KEY_FILE,
                )
            )
            print(f"🔒 HTTPS listener enabled on port {HTTPS_PORT} (push notifications available over LAN).")
        else:
            if HTTPS_CERT_FILE or HTTPS_KEY_FILE:
                missing = [p for p in (HTTPS_CERT_FILE, HTTPS_KEY_FILE) if p and not os.path.exists(p)]
                print(
                    "⚠️ HTTPS disabled because required certificate file(s) are missing: "
                    + ", ".join(missing)
                    + " -- push notifications only work over localhost."
                )
            else:
                print("⚠️ httpsCertFile/httpsKeyFile not set; HTTPS disabled -- push notifications only work over localhost.")

        servers = [uvicorn.Server(c) for c in configs]
        await asyncio.gather(*(s.serve() for s in servers))

    asyncio.run(_run_servers())

