import asyncio
import hmac
import os
import random
import sys
import json
import mimetypes
import tempfile
import time
import datetime
import urllib.request
from contextlib import asynccontextmanager
from urllib.parse import parse_qs, urlencode
from fastapi import FastAPI, Request
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

# Vercel sets this automatically in every deployment (build and runtime) -- see
# https://vercel.com/docs/environment-variables/system-environment-variables. Used to skip
# startup behavior that only makes sense for a persistent local/Windows-service process.
IS_VERCEL = bool(os.getenv("VERCEL"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # start_discovery_listener/start_daily_report_scheduler are defined further down this
    # file (after DiscoveryProtocol/_daily_report_scheduler exist) -- fine, since this body
    # only runs once uvicorn actually starts serving requests, well after the whole module
    # has finished loading. Each is internally guarded by its own _started flag because the
    # local dual-HTTP+HTTPS deployment (see __main__ below) runs two separate uvicorn.Server
    # instances against this SAME app object, and each one drives the ASGI lifespan protocol
    # independently -- without the guards, an HTTPS-enabled local deployment would try to
    # bind the UDP discovery socket twice and start two competing midnight-report loops.
    await start_discovery_listener()
    await start_daily_report_scheduler()
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)

CONFIG_PATH = "webconfig.json"
try:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        webconfig = json.load(f)
except FileNotFoundError:
    webconfig = {}

BUILD_DIR = webconfig.get("staticDir", "Build")
GOOGLE_SHEETS_WEBHOOK_URL = webconfig.get("googleSheetsWebhookUrl", "")
# Turso (libSQL) database for push subscriptions, daily water usage, AI reports, reading
# history, and per-station calibration/mode/breach state (see storage.py) -- reading
# history, calibration, and station state all live here now, not in any in-memory
# structure. Leave "tursoDatabaseUrl" empty to disable it (push subscriptions won't survive
# a restart, daily usage/AI reports won't persist, and reading history/calibration/station
# state reset on every restart, but everything else keeps working). The auth token is a
# real secret -- read from the environment, never committed.
TURSO_DATABASE_URL = webconfig.get("tursoDatabaseUrl", "")
TURSO_AUTH_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "")
# Web Push (see push notification section below). Missing VAPID key file -> push endpoints
# degrade to 503 rather than crashing startup, matching the existing degrade-not-crash
# pattern used by storage.init/the Sheets webhook.
VAPID_PRIVATE_KEY_FILE = webconfig.get("vapidPrivateKeyFile", "vapid_private_key.pem")
VAPID_PUBLIC_KEY = webconfig.get("vapidPublicKey", "")
VAPID_CLAIM_SUB = webconfig.get("vapidSubject", "mailto:admin@example.com")


def _resolve_vapid_key_path() -> str:
    """Returns a usable file path for the VAPID private key. If VAPID_PRIVATE_KEY_FILE
    already exists on disk (the local-deployment case -- a git-ignored file generated once
    per machine via `vapid --gen`), use it as-is. Otherwise, fall back to a
    VAPID_PRIVATE_KEY environment variable holding the raw PEM text and materialize it to
    /tmp (the one writable path in Vercel's otherwise read-only deployment filesystem) once
    at import time -- mirrors _load_gemini_api_key's existing file-then-env-var pattern."""
    if os.path.exists(VAPID_PRIVATE_KEY_FILE):
        return VAPID_PRIVATE_KEY_FILE
    key_text = os.getenv("VAPID_PRIVATE_KEY", "")
    if not key_text:
        return VAPID_PRIVATE_KEY_FILE  # unchanged not-found path; vapid_available() stays False
    tmp_path = os.path.join(tempfile.gettempdir(), "vapid_private_key.pem")
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(key_text)
    return tmp_path


VAPID_PRIVATE_KEY_PATH = _resolve_vapid_key_path()
# HTTPS listener (Web Push requires a secure context; http://localhost is only exempt on
# the same machine). Empty cert/key -> HTTPS stays off, HTTP:8080 behavior is unchanged.
HTTPS_CERT_FILE = webconfig.get("httpsCertFile", "")
HTTPS_KEY_FILE = webconfig.get("httpsKeyFile", "")
HTTPS_PORT = int(webconfig.get("httpsPort", 8443))
# AI daily report (see the "AI daily report" section below and CLAUDE.md). A plain-text
# file, not an inline webconfig.json value, because webconfig.json itself is committed to
# the repo (unlike calibration.json/vapid_private_key.pem) -- an inline key would leak.
# Same degrade-not-crash shape as the VAPID key file: missing -> the feature 503s instead
# of crashing startup.
GEMINI_API_KEY_FILE = webconfig.get("geminiApiKeyFile", "gemini_api_key.txt")
# "gemini-1.5-flash" (this feature's original default) is retired; "gemini-2.5-flash" (the
# next thing tried) is listed by ListModels but rejected at generateContent time with "no
# longer available to new users" -- both confirmed live against a real key during testing.
# gemini-3.6-flash is the model Google's own 404 response recommended, and was verified
# working end-to-end. Override via webconfig.json's "geminiModel" if this is retired too by
# the time you read this -- check with a live ListModels call against your own key first.
GEMINI_MODEL = webconfig.get("geminiModel", "gemini-3.6-flash")
# Minimum time between actual Gemini calls for the same station, regardless of how many
# different browsers/admins hit "Generate now" (or the frontend's own retry) in that window --
# everyone gets back the same already-stored report instead of each click spending its own
# free-tier request. See _generate_ai_report's cooldown check below.
AI_REPORT_COOLDOWN_SECONDS = int(webconfig.get("aiReportCooldownSeconds", 1800))


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
# Falls back to the UPDATE_API_KEY env var when webconfig.json doesn't set it -- mirrors
# _load_gemini_api_key's file-then-env-var pattern, needed specifically for Vercel, where
# webconfig.json is committed to the repo and so can't hold a real secret inline.
UPDATE_API_KEY = webconfig.get("updateApiKey") or os.getenv("UPDATE_API_KEY", "")


def vapid_available() -> bool:
    return os.path.exists(VAPID_PRIVATE_KEY_PATH) and bool(VAPID_PUBLIC_KEY)


def _load_gemini_api_key() -> str:
    try:
        with open(GEMINI_API_KEY_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return os.getenv("GEMINI_API_KEY", "")


GEMINI_API_KEY = _load_gemini_api_key()


def gemini_available() -> bool:
    return bool(GEMINI_API_KEY)

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

if TURSO_DATABASE_URL and storage.init(TURSO_DATABASE_URL, TURSO_AUTH_TOKEN):
    print(f"✅ Turso database at {TURSO_DATABASE_URL} (push subscriptions + daily water usage + AI reports + readings + station state).")
else:
    print("⚠️ Turso database disabled; push subscriptions, daily water usage, AI reports, readings, and calibration/station state won't persist.")

if gemini_available():
    print(f"✅ AI daily report enabled ({GEMINI_MODEL}) -- generates once per local midnight, per station.")
else:
    print(f"⚠️ {GEMINI_API_KEY_FILE} not found; AI daily report disabled (GET/POST /ai-report* return 503).")

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

async def start_discovery_listener():
    # Called from lifespan() (see above), not a route decorator any more -- FastAPI's
    # @app.on_event is deprecated. Skipped entirely on Vercel: a serverless container has no
    # LAN to discover firmware on, and binding an ephemeral UDP port on every cold start is
    # pure waste even if the bind itself doesn't outright fail in that sandboxed environment.
    if IS_VERCEL:
        return
    # Called once per uvicorn.Server instance sharing this app (see lifespan()'s docstring
    # comment) -- guard so the UDP socket, a single process-wide resource, is only bound
    # once. Without this a local HTTPS-enabled deployment's second server would raise
    # OSError (WinError 10048) on its bind attempt and fail startup entirely.
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


async def start_daily_report_scheduler():
    # Called from lifespan(), not a route decorator any more. Skipped on Vercel -- an
    # in-process loop that sleeps until local midnight is meaningless in a serverless
    # container that can be recycled anytime; Vercel Cron (see /ai-report/generate-all)
    # replaces it there instead.
    if IS_VERCEL:
        return
    # Same double-lifespan-invocation concern as start_discovery_listener above.
    global _daily_scheduler_started
    if _daily_scheduler_started:
        return
    _daily_scheduler_started = True
    asyncio.create_task(_daily_report_scheduler())

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


# Today's date as a local calendar-day string -- the key daily-resetting state (water usage,
# the AI daily report's rollup/cooldown) is bucketed by. Kept as a plain function (not cached)
# since callers need to detect a rollover by comparing against a freshly computed value.
def _local_date() -> str:
    return datetime.date.today().isoformat()


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
# the coefficients persisted per-station in Turso's `station_state` table (storage.py),
# loaded/saved via _load_station_state/_save_station_state below.
#
#   turbidity: 2-point linear ADC -> NTU. Higher ADC = clearer water, so slope is negative.
#              Uncalibrated (fewer than 2 points) => apply_turbidity returns None (no NTU).
#   tds:       DFRobot temperature-compensated ppm formula (moved here from the firmware)
#              scaled by a single k-factor fitted against one known-ppm solution.


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


async def _load_station_state(station: str) -> tuple[dict, bool, dict]:
    """Returns (calibration, calibration_mode, last_severity) for `station` from Turso,
    or fresh defaults if it has never had a station_state row (a brand-new station, or Turso
    disabled). Every /update and every /calibration* endpoint calls this once per request --
    there is no in-memory cache any more (see the per-station-state Turso migration spec)."""
    state = await asyncio.to_thread(storage.get_station_state, station) if storage.enabled() else None
    if state is None:
        return _default_calibration(), False, {}
    # Merge over a full default shape rather than trusting state["calibration"] directly --
    # a partial/empty calibration blob (e.g. update_last_severity's INSERT-only branch before
    # it was fixed to pass a real default, or any future/manual write that leaves a sensor key
    # out) would otherwise propagate a dict missing "turbidity"/"tds"/"flow", crashing any
    # caller that indexes straight into calib[sensor]["coefficients"].
    calib = _default_calibration()
    for sensor in CALIBRATED_SENSORS:
        if isinstance(state["calibration"].get(sensor), dict):
            calib[sensor].update(state["calibration"][sensor])
    return calib, state["calibrationMode"], state["lastSeverity"]


async def _save_station_state(station: str, calib: dict, mode: bool, last_severity: dict) -> None:
    if storage.enabled():
        await asyncio.to_thread(storage.upsert_station_state, station, calib, mode, last_severity)


def _turbidity_stat_column(calib: dict, station_mode: bool) -> str:
    """Which readings-table column holds the turbidity value this station is actually
    DISPLAYING right now -- NTU only when mode is ON *and* a real calibration exists
    (>=2 captured points), not just when mode is toggled on. Using `station_mode` alone
    as the condition is wrong: a station can have mode ON with zero calibration points,
    in which case turbidity_ntu is all-NULL and every consumer of this column silently
    loses turbidity's min/max. Centralized here so /update, GET /live, and
    the AI report prompt-builder can't diverge on this choice."""
    has_calibration = bool(calib["turbidity"]["coefficients"])
    return "turbidity_ntu" if (station_mode and has_calibration) else "turbidity_raw"


def _now_iso() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def _recompute_turbidity(calib: dict) -> None:
    # 2-point linear fit. With >2 points, use the first and last by raw ADC so the line
    # spans the full captured range; a single point can't define a slope.
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


def _recompute_tds(calib: dict) -> None:
    # Single-point k-factor: k = known_ppm / dfrobot_ppm at the captured voltage/temp.
    points = calib["tds"]["points"]
    if not points:
        calib["tds"]["coefficients"] = {"k": 1.0}
        return
    p = points[-1]
    base = _dfrobot_ppm(p["rawVoltage"], p.get("temperature", 25.0))
    k = (p["reference"] / base) if base > 0 else 1.0
    calib["tds"]["coefficients"] = {"k": k}


def apply_turbidity(calib: dict, adc: float):
    coeffs = calib["turbidity"]["coefficients"]
    if not coeffs:
        return None
    ntu = coeffs["slope"] * adc + coeffs["intercept"]
    return round(max(0.0, ntu), 1)


def apply_tds(calib: dict, voltage: float, temperature_c) -> float:
    k = (calib["tds"]["coefficients"] or {}).get("k", 1.0)
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


def _recompute_flow(calib: dict) -> None:
    # Single-point k-factor, same shape as _recompute_tds: k = counted_pulses / measured
    # liters (pulses per liter), from a "pour a known volume through, capture the pulse
    # count" calibration point.
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


def apply_flow(calib: dict, mode: bool, pulses: float) -> tuple[float, float]:
    """Returns (litersThisInterval, flowRateLpm) from a raw pulse count. Only applies the
    saved k-factor when calibration mode is ON (mirrors apply_tds); OFF uses the nominal
    YF-S201 default so an unconfigured/miscalibrated k can't silently skew the live reading."""
    k = (calib["flow"]["coefficients"] or {}).get("k", 450.0) if mode else 450.0
    if not k:
        return 0.0, 0.0
    liters = pulses / k
    rate_lpm = liters * (60.0 / FLOW_INTERVAL_SECONDS)
    return round(liters, 4), round(rate_lpm, 2)


# --- Push notifications -------------------------------------------------------
# Breach detection runs synchronously/inline on every reading (edge-triggered good->warn/
# danger transition tracked in each station's severity dict -- loaded via
# _load_station_state and persisted via _save_station_state, so out-of-order dispatch can't
# corrupt it); the actual network sends are deferred via asyncio.create_task off Vercel --
# same fire-and-forget reasoning as the Sheets relay in update_sensor, don't block the
# ESP32's response for a process that stays alive to finish the send anyway. On Vercel
# (IS_VERCEL), update_sensor awaits this directly instead, since a fire-and-forget task can
# be silently dropped when the serverless container freezes right after the response.

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


def _check_breaches_and_dispatch(station_severity: dict, payload: dict) -> list:
    """Mutates `station_severity` in place (edge-detection state for one station), returns
    the list of (param, severity) pairs that just crossed into warn/danger this reading."""
    breaches = []
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
            vapid_private_key=VAPID_PRIVATE_KEY_PATH,
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


# --- AI daily report (Gemini) -------------------------------------------------
# A once-a-day, per-station plain-language summary of the day's water-quality stats, built
# from Turso's `readings` table (min/max/avg + threshold-breach counts since local midnight,
# see `_build_daily_report_prompt`) into a short analysis a non-technical school administrator
# can read at a glance -- generated by Gemini's free-tier
# API, called directly via urllib (same fire-and-forget-safe REST style as
# `_post_to_google_sheets` above; no new pip dependency). Fires automatically at local
# midnight (see `_daily_report_scheduler` near the bottom of this file) and on-demand via
# `POST /ai-report/generate` (the dashboard's admin-only "Generate now" button, for demoing
# without waiting for real midnight).
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def _local_midnight_ms() -> int:
    now = datetime.datetime.now()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(midnight.timestamp() * 1000)


async def _build_daily_report_prompt(station: str) -> str:
    since_ms = _local_midnight_ms()
    calib, station_mode, _severity = await _load_station_state(station)
    # Same per-station unit choice /live's stats block makes via _turbidity_stat_column --
    # NTU once calibrated, else raw ADC.
    columns = {
        "temperature": "temperature",
        "turbidity": _turbidity_stat_column(calib, station_mode),
        "tds": "tds_ppm",
        "ec": "ec",
    }
    extremes = await asyncio.to_thread(
        storage.get_reading_extremes, station, since_ms, tuple(columns.values())
    )
    lines = [
        "สรุปสถานการณ์คุณภาพน้ำวันนี้ให้สั้น กระชับ เข้าใจง่าย เป็นภาษาไทย 3-5 ประโยค "
        "สำหรับผู้บริหารสถานศึกษาที่ไม่ใช่สายเทคนิค โดยเน้นว่าค่าที่วัดได้ปกติดีหรือมีจุดที่ควรเฝ้าระวัง:"
    ]
    for param in PUSH_PARAMS:
        col = columns.get(param)
        stat = extremes.get(col) if col else None
        if not stat:
            continue
        _emoji, label, unit = PARAM_DISPLAY.get(param, ("", param.capitalize(), ""))
        values = await asyncio.to_thread(storage.get_reading_values, station, since_ms, col)
        breaches = sum(
            1
            for v in values
            if not thresholds.is_sensor_fault(param, v)
            and thresholds.range_status_for(param, v) in ("warn", "danger")
        )
        lines.append(
            f"- {label}: ต่ำสุด {stat['min']:.1f}, สูงสุด {stat['max']:.1f}, "
            f"เฉลี่ย {stat['avg']:.1f} {unit}, เกินเกณฑ์เฝ้าระวัง/อันตราย {breaches} ครั้งจาก {stat['count']} ครั้งที่วัด"
        )
    return "\n".join(lines)


def _call_gemini(prompt: str) -> str | None:
    url = GEMINI_ENDPOINT.format(model=GEMINI_MODEL) + f"?key={GEMINI_API_KEY}"
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception as exc:
        print(f"⚠️ Gemini AI report generation failed: {exc}")
        return None


async def _generate_ai_report(station: str) -> tuple[str | None, bool]:
    """Builds and persists one AI daily report for `station` right now (used by both the
    midnight scheduler and the manual admin "Generate now" endpoint). Never raises -- a
    failure (missing key, network error, rate limit, malformed response) is logged and
    returns (None, False), leaving whatever report was already stored untouched, same
    fail-soft philosophy as the Google Sheets relay.

    Returns (text, cached): `cached=True` means no Gemini call was made at all -- an
    existing report for this station is still within AI_REPORT_COOLDOWN_SECONDS, so the
    already-stored text is returned as-is. This is the anti-exploit guard: however many
    different browsers/admins hit "Generate now" (or however fast one browser retries) in
    that window, they all see the exact same text and only the FIRST one actually spent a
    free-tier request -- without this, a spammed button (accidentally or deliberately) could
    burn through the daily/per-minute quota in seconds."""
    if not gemini_available():
        return None, False
    if storage.enabled():
        latest = await asyncio.to_thread(storage.get_latest_ai_report, station)
        if latest and latest.get("created_ms") is not None:
            age_seconds = (time.time() * 1000 - latest["created_ms"]) / 1000
            if age_seconds < AI_REPORT_COOLDOWN_SECONDS:
                return latest["report"], True
    prompt = await _build_daily_report_prompt(station)
    text = await asyncio.to_thread(_call_gemini, prompt)
    if text is None:
        return None, False
    today = _local_date()
    if storage.enabled():
        await asyncio.to_thread(storage.save_ai_report, today, station, text)
    return text, False


_daily_scheduler_started = False


async def _seconds_until_next_midnight() -> float:
    now = datetime.datetime.now()
    tomorrow = (now + datetime.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return (tomorrow - now).total_seconds()


async def _daily_report_scheduler() -> None:
    while True:
        await asyncio.sleep(await _seconds_until_next_midnight())
        stations_to_report = await asyncio.to_thread(storage.list_stations) if storage.enabled() else []
        for station in stations_to_report:
            # Isolate each station's generation the same way generate_ai_reports_all (the
            # Vercel Cron sibling of this loop) does -- one station's Turso/Gemini failure
            # shouldn't silently stop every later station's report from generating tonight.
            try:
                await _generate_ai_report(station)
            except Exception as exc:
                print(f"⚠️ AI report generation failed for station {station!r}: {exc}")


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

        calib, station_mode, station_severity = await _load_station_state(station)
        breaches: list = []

        if "temperature" in data and "turbidity" in data:
            payload["temperature"] = float(data["temperature"])
            # Turbidity arrives as the averaged raw ADC and is kept in `turbidity` (both
            # dashboards read that key). The calibrated NTU rides along in `turbidityNtu`
            # when a turbidity calibration is active (else None).
            turbidity_adc = float(data["turbidity"])
            # Only apply this station's saved calibration when calibration mode is ON (the
            # Calibration tab's on/off button). OFF => ntu stays None => dashboard shows raw ADC.
            ntu = apply_turbidity(calib, turbidity_adc) if station_mode else None
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

            # TDS: prefer the raw voltage from current firmware (backend computes ppm via
            # calibration). Fall back to a legacy pre-computed `tds` ppm from an un-reflashed
            # board so the old firmware keeps working (backward-compatible contract).
            if "tdsVoltage" in data:
                tds_voltage = float(data["tdsVoltage"])
                payload["tdsVoltage"] = tds_voltage
                # Apply the k-factor only when calibration mode is ON; OFF => uncalibrated
                # DFRobot ppm (k = 1.0).
                payload["tds"] = (
                    apply_tds(calib, tds_voltage, payload["temperature"])
                    if station_mode
                    else round(_dfrobot_ppm(tds_voltage, payload["temperature"]), 1)
                )
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
                liters, flow_rate = apply_flow(calib, station_mode, flow_pulses)
                payload["flowRate"] = flow_rate
                if storage.enabled():
                    total = await asyncio.to_thread(storage.add_daily_usage, _local_date(), station, liters)
                else:
                    # No Turso, no in-memory cache any more -- this interval's own liters is
                    # the best available answer, not a running daily total.
                    total = liters
                payload["waterUsageToday"] = round(total, 4)

            if storage.enabled():
                ts_ms = payload["timestamp"] * 1000
                await asyncio.to_thread(
                    storage.insert_reading,
                    station,
                    ts_ms,
                    {
                        "temperature": payload.get("temperature"),
                        "turbidity_raw": payload.get("turbidityRaw"),
                        "turbidity_ntu": payload.get("turbidityNtu"),
                        "tds_voltage": payload.get("tdsVoltage"),
                        "tds_ppm": payload.get("tds"),
                        "ec": payload.get("ec"),
                        "flow_pulses": data.get("flowPulses"),
                        "flow_rate": payload.get("flowRate"),
                    },
                )
                # Opportunistic retention prune (not on every write -- a DELETE scan on every
                # 2s reading would be wasteful). ~1/100 writes is frequent enough that the
                # table never grows far past 24h + a few minutes of readings. Always awaited
                # directly (not fire-and-forget): a DELETE query adds negligible latency and
                # only runs ~1% of the time, and on Vercel's serverless runtime a task merely
                # created (not awaited) can be silently dropped if the container freezes/tears
                # down right after the HTTP response is sent.
                if random.random() < 0.01:
                    cutoff_ms = int((time.time() - 86400) * 1000)
                    await asyncio.to_thread(storage.prune_readings, cutoff_ms)

            # Threshold-breach push notifications: detection is synchronous/inline (must
            # observe every reading in order to edge-detect correctly); the actual sends are
            # deferred below, like the Sheets relay.
            breaches = _check_breaches_and_dispatch(station_severity, payload)
        else:
            text = await request.body()
            if not text:
                return JSONResponse({"error": "missing body"}, status_code=400)

            parsed = parse_qs(text.decode("utf-8", errors="ignore"), keep_blank_values=True)
            water_level = parsed.get("water_level", [None])[0]
            if water_level is None:
                return JSONResponse({"error": "missing water_level"}, status_code=400)

            payload["water_level"] = int(float(water_level))

        if storage.enabled():
            # /update never modifies calib/station_mode -- only station_severity (breach
            # edge-detection). Writing through update_last_severity (not
            # _save_station_state/upsert_station_state) touches only that one column, so this
            # every-2s write can't race a concurrent /calibration* endpoint's read-modify-write
            # of the same row and clobber a just-captured calibration point. See
            # storage.update_last_severity's docstring.
            await asyncio.to_thread(
                storage.update_last_severity, station, station_severity, json.dumps(calib)
            )

        print(f"Received sensor update: {payload}")
        if "temperature" in payload:
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
            if IS_VERCEL:
                # Vercel's serverless container may freeze/terminate immediately after the HTTP
                # response is sent -- a task merely CREATED but not yet awaited can silently never
                # run. Awaiting here trades a slightly slower /update response for actually
                # guaranteeing the Sheets relay/push dispatch happens on this deployment target.
                await relay_to_google_sheets(sheet_payload)
            else:
                asyncio.create_task(relay_to_google_sheets(sheet_payload))

            if breaches:
                if IS_VERCEL:
                    await dispatch_push_breaches(breaches, payload)
                else:
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


def _with_ntu(calib: dict, station: str, rows: list) -> list:
    # Turso-backed rows already carry a computed turbidityNtu (set at insert time in
    # /update). Sheet-backed rows (long windows) only have raw `turbidity` -- compute NTU for
    # those here so both sources agree.
    out = []
    for r in rows:
        ntu = r.get("turbidityNtu")
        if ntu is None:
            adc = r.get("turbidity")
            ntu = apply_turbidity(calib, adc) if isinstance(adc, (int, float)) else None
        # Sheet-backed rows (long windows) have no `ec` column -- derive it from tds so the
        # EC graph works across every window.
        ec = r.get("ec")
        if ec is None:
            ec = ppm_to_ec(r.get("tds"))
        # Sheets rows carry flowRate once google_apps_script.gs has been redeployed with its
        # Flow Rate column (see CLAUDE.md); rows logged before that redeploy, or rows where a
        # reading simply had no flow data, fall back to None here uniformly.
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
      1. Turso's `readings` table -- answers instantly for anything still in the rolling window;
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

    # Tier 1 -- Turso `readings`, the whole live path (pruned to 24h -- see storage.py).
    rows = await asyncio.to_thread(storage.get_readings, station, cutoff_ms) if storage.enabled() else []
    if rows:
        sources.append("live")

    # Tier 2 -- Sheets fills the older end when Turso doesn't reach far enough back. The
    # tolerance keeps a normal steady-state request (oldest row a second or two after the
    # cutoff) from counting as a gap; see HISTORY_GAP_TOLERANCE_MS.
    local_floor_ms = rows[0]["timestamp"] if rows else float("inf")
    coverage_gap = (not rows) or (local_floor_ms > cutoff_ms + HISTORY_GAP_TOLERANCE_MS)

    if coverage_gap and GOOGLE_SHEETS_WEBHOOK_URL:
        sheet_rows, err = await _fetch_sheet_rows(seconds, cutoff_ms, HISTORY_MAX_POINTS, station)
        # Keep only rows strictly older than what Turso already covers, so the merge has no
        # duplicate/overlapping rows at the seam.
        sheet_rows = [r for r in sheet_rows if r["timestamp"] < local_floor_ms]
        if sheet_rows:
            rows = sheet_rows + rows  # both chronological ascending -> merge stays ordered
            sources.append("sheet")
        if err is not None and not rows:
            return JSONResponse(
                {"rows": [], "windowSeconds": seconds, "error": err, "source": "sheet"}
            )

    calib, _mode, _severity = await _load_station_state(station)
    return JSONResponse({
        "rows": _with_ntu(calib, station, _downsample(rows, HISTORY_MAX_POINTS)),
        "windowSeconds": seconds,
        "source": "+".join(sources) if sources else "none",
    })


@app.get("/live")
async def get_live():
    """Snapshot of every station's current live state -- the Vercel-compatible replacement
    for the old WS /ws/app prime-frame + broadcast mechanism (removed from this file).
    Vercel's serverless Python functions can't hold a persistent connection open across requests, so
    the frontend polls this on an interval (useSensorSocket.ts) instead of listening for
    pushed frames. Returns the same per-station content the old prime frame built once per
    connection -- now just re-computed fresh on every call."""
    station_names = await asyncio.to_thread(storage.list_stations) if storage.enabled() else []
    stations: dict = {}
    today = _local_date()
    for station in station_names:
        last = await asyncio.to_thread(storage.get_latest_reading, station)
        if last is None:
            stations[station] = {"hasData": False, "reading": None, "stats": None}
            continue

        calib, station_mode, _severity = await _load_station_state(station)
        turbidity_adc = last.get("turbidity")
        ntu = last.get("turbidityNtu")
        if ntu is None and station_mode and turbidity_adc is not None:
            ntu = apply_turbidity(calib, turbidity_adc)

        stat_columns = {
            "temperature": "temperature",
            "turbidity": _turbidity_stat_column(calib, station_mode),
            "tds": "tds_ppm",
            "flowRate": "flow_rate",
        }
        # NOTE: since_ms=0 scans every retained row (up to 24h) on every call, once per
        # station polled here -- an accepted tradeoff of this migration's
        # no-in-process-caching design (see
        # docs/superpowers/specs/2026-09-08-station-state-turso-migration-design.md), not
        # free, but not a correctness bug. A future pass could maintain running min/max as
        # columns on station_state instead if this becomes a measured bottleneck. This is the
        # same query the old WS prime frame ran per connecting client; polling now runs it
        # per station per poll interval instead -- a materially higher call rate, tracked as
        # the same accepted tradeoff, not a new one this endpoint introduces.
        extremes = await asyncio.to_thread(
            storage.get_reading_extremes, station, 0, tuple(set(stat_columns.values()))
        )
        stats = {
            key: {"min": extremes[col]["min"], "max": extremes[col]["max"]}
            for key, col in stat_columns.items()
            if col in extremes
        }

        water_usage_today = (
            await asyncio.to_thread(storage.get_daily_usage, today, station)
            if storage.enabled()
            else None
        )

        stations[station] = {
            "hasData": True,
            "reading": {
                "station": station,
                "timestamp": last["timestamp"] // 1000,
                "temperature": last.get("temperature"),
                "turbidityRaw": turbidity_adc,
                "turbidityNtu": ntu,
                "turbidity": ntu if ntu is not None else turbidity_adc,
                "turbidityUnit": "NTU" if ntu is not None else "ADC",
                "tds": last.get("tds"),
                "tdsVoltage": last.get("tdsVoltage"),
                "ec": last.get("ec"),
                "flowRate": last.get("flowRate"),
                "waterUsageToday": water_usage_today,
            },
            "stats": stats or None,
        }

    return JSONResponse({"stationNames": station_names, "stations": stations})


# --- Calibration API ---------------------------------------------------------
# Drives the frontend's Calibration tab. State is loaded/saved per-station via
# _load_station_state/_save_station_state (Turso's `station_state` table) -- every capture
# is immediately live (persisted the moment it's captured), no separate draft/Save step.


async def _avg_raw(station: str, column: str):
    """`column` is one of the readings-table raw columns ("turbidity_raw", "tds_voltage",
    "flow_pulses"). Averages the last 5 non-null values; falls back to the single latest
    reading if fewer than 5 (or zero) are available."""
    if not storage.enabled():
        return None
    values = await asyncio.to_thread(storage.get_recent_raw, station, column, 5)
    if values:
        return sum(values) / len(values)
    latest = await asyncio.to_thread(storage.get_latest_reading, station)
    if not latest:
        return None
    key_map = {"turbidity_raw": "turbidity", "tds_voltage": "tdsVoltage", "flow_pulses": "flowPulses"}
    return latest.get(key_map[column])


@app.get("/calibration")
async def get_calibration(station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    calib, mode, _severity = await _load_station_state(station)
    latest = await asyncio.to_thread(storage.get_latest_reading, station) if storage.enabled() else None
    latest = latest or {}
    return JSONResponse(
        {
            "mode": mode,
            "turbidity": calib["turbidity"],
            "tds": calib["tds"],
            "flow": calib["flow"],
            "latestRaw": {
                "turbidity": latest.get("turbidity"),
                "tdsVoltage": latest.get("tdsVoltage"),
                "temperature": latest.get("temperature"),
                "flowRaw": latest.get("flowPulses"),
            },
        }
    )


@app.post("/calibration/mode")
async def set_calibration_mode(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    calib, _old_mode, severity = await _load_station_state(station)
    mode = bool(body.get("enabled"))
    await _save_station_state(station, calib, mode, severity)
    return JSONResponse({"mode": mode})


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

    raw_column = {"turbidity": "turbidity_raw", "tds": "tds_voltage", "flow": "flow_pulses"}[sensor]
    manual_raw = body.get("raw")
    if manual_raw is not None and manual_raw != "":
        try:
            raw = float(manual_raw)
        except (TypeError, ValueError):
            return JSONResponse({"error": "raw must be numeric"}, status_code=400)
    else:
        raw = await _avg_raw(station, raw_column)
        if raw is None:
            unit = {"turbidity": "Raw ADC", "tds": "Raw V", "flow": "pulse count"}[sensor]
            return JSONResponse(
                {"error": f"no live {sensor} reading yet — type a {unit} value instead"},
                status_code=409,
            )

    calib, mode, severity = await _load_station_state(station)
    latest = await asyncio.to_thread(storage.get_latest_reading, station) if storage.enabled() else None
    latest = latest or {}
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
                "temperature": latest.get("temperature") if latest.get("temperature") is not None else 25.0,
            }
        )
    else:
        calib["flow"]["points"].append(
            {"rawPulses": round(raw, 1), "reference": reference, "label": label}
        )
    _RECOMPUTE_FNS[sensor](calib)
    # Captures are immediately live (no separate draft/Save step -- see the migration spec)
    # so this stamps `updated` right away rather than waiting for a POST /calibration/save.
    calib[sensor]["updated"] = _now_iso()
    await _save_station_state(station, calib, mode, severity)

    return JSONResponse({sensor: calib[sensor]})


@app.delete("/calibration/point")
async def delete_calibration_point(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in CALIBRATED_SENSORS:
        return JSONResponse({"error": "sensor must be 'turbidity', 'tds', or 'flow'"}, status_code=400)
    calib, mode, severity = await _load_station_state(station)
    try:
        index = int(body["index"])
        calib[sensor]["points"].pop(index)
    except (KeyError, TypeError, ValueError, IndexError):
        return JSONResponse({"error": "valid point index required"}, status_code=400)
    _RECOMPUTE_FNS[sensor](calib)
    calib[sensor]["updated"] = _now_iso()
    await _save_station_state(station, calib, mode, severity)
    return JSONResponse({sensor: calib[sensor]})


@app.post("/calibration/save")
async def save_calibration(station: str = DEFAULT_STATION):
    # Every capture already persists immediately (see /calibration/capture above) -- this
    # endpoint's only remaining job is stamping every sensor's `updated` timestamp, kept for
    # the frontend's existing Save button to still do something meaningful.
    station = _normalize_station(station)
    calib, mode, severity = await _load_station_state(station)
    now = _now_iso()
    for sensor in CALIBRATED_SENSORS:
        calib[sensor]["updated"] = now
    await _save_station_state(station, calib, mode, severity)
    print(f"💾 Calibration confirmed (station={station!r})")
    return JSONResponse({"ok": True, **{s: calib[s] for s in CALIBRATED_SENSORS}})


@app.post("/calibration/reset")
async def reset_calibration(request: Request, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    body = await request.json()
    sensor = body.get("sensor")
    if sensor not in CALIBRATED_SENSORS:
        return JSONResponse({"error": "sensor must be 'turbidity', 'tds', or 'flow'"}, status_code=400)
    calib, mode, severity = await _load_station_state(station)
    calib[sensor] = _default_calibration()[sensor]
    await _save_station_state(station, calib, mode, severity)
    return JSONResponse({sensor: calib[sensor]})


# --- Flow sensor API ----------------------------------------------------------
# Separate from /history: daily usage is one row per calendar day (storage.daily_usage),
# a different shape/cadence than live readings, so it needs its own small endpoints rather
# than riding the /history buffer+Sheets merge (see storage.py's daily_usage table docstring).


@app.get("/flow/usage")
async def get_flow_usage(days: int = 14, station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    if not storage.enabled():
        return JSONResponse({"today": 0.0, "days": []})
    days = max(1, min(days, 365))
    today_total = await asyncio.to_thread(storage.get_daily_usage, _local_date(), station)
    rows = await asyncio.to_thread(storage.get_recent_daily_usage, station, days)
    return JSONResponse({"today": round(today_total, 4), "days": rows})


@app.post("/flow/reset-today")
async def reset_flow_usage_today(station: str = DEFAULT_STATION):
    station = _normalize_station(station)
    if storage.enabled():
        await asyncio.to_thread(storage.reset_daily_usage, _local_date(), station)
    return JSONResponse({"ok": True, "today": 0.0})


@app.get("/ai-report")
async def get_ai_report(station: str = DEFAULT_STATION):
    if not gemini_available():
        return JSONResponse({"error": "AI daily report is not configured"}, status_code=503)
    station = _normalize_station(station)
    if not storage.enabled():
        return JSONResponse({"station": station, "date": None, "report": None})
    latest = await asyncio.to_thread(storage.get_latest_ai_report, station)
    if latest is None:
        return JSONResponse({"station": station, "date": None, "report": None})
    return JSONResponse({"station": station, "date": latest["date"], "report": latest["report"]})


@app.post("/ai-report/generate")
async def generate_ai_report_now(station: str = DEFAULT_STATION):
    # Manual override for the dashboard's admin-only "Generate now" button, so a demo
    # doesn't have to wait for the real midnight scheduler. NOT backend-auth-gated -- same
    # precedent as /station/rename: "admin" is a frontend-only UI role (see
    # RoleProvider.tsx's own header comment), not real authentication.
    if not gemini_available():
        return JSONResponse({"error": "AI daily report is not configured"}, status_code=503)
    station = _normalize_station(station)
    text, cached = await _generate_ai_report(station)
    if text is None:
        return JSONResponse({"error": "AI report generation failed"}, status_code=502)
    return JSONResponse({"station": station, "date": _local_date(), "report": text, "cached": cached})


@app.get("/ai-report/generate-all")
async def generate_ai_reports_all(request: Request):
    """Vercel Cron's target (see vercel.json's "crons" entry) -- generates (or, within
    cooldown, returns the cached) AI daily report for every station that currently has data,
    the same loop _daily_report_scheduler's local-deployment midnight path already runs.
    Cron hits one URL on a schedule; this fans that single trigger out across every known
    station. GET, not POST -- Vercel always invokes a cron target via HTTP GET, unlike the
    admin-only POST /ai-report/generate this reuses the same underlying logic as. Not
    backend-auth-gated, same precedent as that per-station endpoint -- every call is already
    cooldown-protected (AI_REPORT_COOLDOWN_SECONDS), so an internet-reachable trigger can't
    burn through the Gemini quota any faster than the existing manual button already
    couldn't. If CRON_SECRET is set as an env var -- a real secret the deployer creates and
    sets themselves, e.g. in the Vercel project's environment variables, NOT something Vercel
    provisions automatically -- requires a matching Authorization: Bearer header; Vercel then
    sends that header automatically on its own cron-triggered requests once the var exists,
    but a fresh deployment that never sets CRON_SECRET leaves this endpoint open by default.
    Unset locally, so local/dev calls are unaffected either way. Each station's generation is
    isolated in its own
    try/except so one station's Turso/Gemini failure can't abort the whole fan-out."""
    cron_secret = os.getenv("CRON_SECRET", "")
    if cron_secret and not hmac.compare_digest(
        request.headers.get("authorization", ""), f"Bearer {cron_secret}"
    ):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    stations = await asyncio.to_thread(storage.list_stations) if storage.enabled() else []
    results = {}
    for station in stations:
        try:
            text, cached = await _generate_ai_report(station)
            results[station] = {"generated": text is not None, "cached": cached}
        except Exception as exc:
            print(f"⚠️ AI report generation failed for station {station!r}: {exc}")
            results[station] = {"generated": False, "cached": False, "error": str(exc)}
    return JSONResponse({"stations": results})


@app.post("/station/rename")
async def rename_station(request: Request):
    body = await request.json()
    old_raw = body.get("old")
    if not isinstance(old_raw, str) or not old_raw.strip():
        return JSONResponse({"error": "old station name is required"}, status_code=400)
    old = _normalize_station(old_raw)
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

    if not storage.enabled():
        return JSONResponse(
            {"error": "station rename requires the Turso database to be enabled"}, status_code=503
        )

    old_exists = await asyncio.to_thread(storage.station_exists, old)
    if not old_exists:
        return JSONResponse({"error": f'station "{old}" not found'}, status_code=404)

    new_exists = await asyncio.to_thread(storage.station_exists, new)
    if new_exists:
        return JSONResponse({"error": f'station "{new}" already exists'}, status_code=409)

    await asyncio.to_thread(storage.rename_readings, old, new)
    await asyncio.to_thread(storage.rename_station_state, old, new)
    await asyncio.to_thread(storage.rename_station_usage, old, new)
    await asyncio.to_thread(storage.rename_ai_reports, old, new)

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
                vapid_private_key=VAPID_PRIVATE_KEY_PATH,
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


# The Aqua Monitor React app (frontend/) is the default page, mounted at "/" LAST so it
# only catches requests that no explicit route above already matched (Starlette tries
# routes in registration order; specific routes like /history, /calibration, /live all win
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
    # deployment: it watches the working directory, so any file change in it would restart
    # the server -- causing any in-flight requests (including a dashboard's GET /live poll)
    # to fail. Reading history, calibration, and daily usage all live in Turso now, so a
    # restart no longer loses them, only that one poll cycle. It also runs a supervisor +
    # child process, which double-binds the UDP discovery port on restart.
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

