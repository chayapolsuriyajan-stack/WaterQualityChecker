"""USB-serial bridge to the ESP32 firmware's WiFi-provisioning protocol (WIFI_SCAN/WIFI_SET/
WIFI_STATUS -- see esp32.ino's "USB WiFi provisioning" section). This is a SEPARATE channel
from the normal HTTP-over-WiFi sensor path (main.py's /update): it exists only because the
ESP32 has no working WiFi at the moment new credentials need to be entered, so the USB cable
is the only way to reach it. Once provisioned, everything else keeps working exactly as
before -- USB is a provisioning channel here, never a replacement for the sensor-data path.

Design notes (mirrors storage.py):
- One module-level `serial.Serial` connection, lazily opened and reused across calls, guarded
  by a lock. Every public function here is blocking (serial I/O), and main.py calls them via
  asyncio.to_thread so a slow/stuck port never stalls the event loop or the ESP32's own
  /update handling.
- Every function degrades gracefully -- a missing/unplugged ESP32 (or a busy port, e.g. the
  Arduino IDE's own Serial Monitor already has it open) returns a clear {"ok": False, ...}
  result, never raises past this module's boundary, matching the app's existing
  never-crash-on-a-missing-peripheral posture (storage.py, the push-notification endpoints).
- Opening a fresh connection to most ESP32 dev boards toggles DTR/RTS, which resets the chip
  (the same auto-reset behavior esptool relies on for flashing) -- the first call after backend
  startup (or after the board was unplugged/replugged) pays a ~2s settle delay for this; later
  calls reuse the already-open connection and don't pay it again.
"""

import threading
import time

try:
    import serial
    import serial.tools.list_ports
except ImportError:  # pyserial not installed -- degrade to "unavailable", never crash startup
    serial = None

BAUD_RATE = 115200
_BOOT_SETTLE_SECONDS = 2.0  # let the ESP32 finish its DTR/RTS-triggered reset before talking to it

# Common ESP32 dev-board USB-to-serial chip VID:PID pairs. Not exhaustive -- boards vary --
# but covers the two chips on the overwhelming majority of ESP32 dev boards.
KNOWN_VID_PID = {
    (0x10C4, 0xEA60),  # Silicon Labs CP2102/CP2104
    (0x1A86, 0x7523),  # QinHeng CH340
    (0x1A86, 0x55D4),  # QinHeng CH9102 (newer CH340 variant, some ESP32-S3 boards)
}

_conn = None
_lock = threading.Lock()
_configured_port: str | None = None  # webconfig.json's esp32SerialPort override, if set


def configure(port_override: str | None) -> None:
    """Called once at startup from main.py with webconfig.json's esp32SerialPort (or None)."""
    global _configured_port
    _configured_port = port_override or None


def available() -> bool:
    return serial is not None


def find_port() -> str | None:
    """The configured override if set, else the first port matching a known ESP32 USB-serial
    chip. None if pyserial isn't installed or nothing matches."""
    if serial is None:
        return None
    if _configured_port:
        return _configured_port
    for p in serial.tools.list_ports.comports():
        if (p.vid, p.pid) in KNOWN_VID_PID:
            return p.device
    return None


def _get_connection():
    """Returns an open connection to the ESP32's port, (re)opening as needed. None if
    unavailable (pyserial missing, port not found, or open failed -- e.g. the port is busy)."""
    global _conn
    port = find_port()
    if port is None:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
        return None
    if _conn is not None and _conn.port == port and _conn.is_open:
        return _conn
    if _conn is not None:
        try:
            _conn.close()
        except Exception:
            pass
        _conn = None
    try:
        conn = serial.Serial(port, BAUD_RATE, timeout=0.5)
        time.sleep(_BOOT_SETTLE_SECONDS)
        conn.reset_input_buffer()
        _conn = conn
        return _conn
    except Exception as exc:
        print(f"⚠️ Couldn't open ESP32 serial port {port}: {exc}")
        return None


def _send_line(conn, line: str) -> None:
    conn.write((line + "\n").encode("utf-8"))


def _read_lines_until(conn, prefixes: tuple, timeout: float) -> list[str]:
    """Reads lines until one starts with any of `prefixes`, or `timeout` seconds elapse.
    Returns every complete line seen along the way (including the firmware's own unrelated
    debug Serial.println output, which callers filter for their specific WIFI_ prefix)."""
    lines: list[str] = []
    deadline = time.monotonic() + timeout
    buf = b""
    while time.monotonic() < deadline:
        chunk = conn.read(conn.in_waiting or 1)
        if not chunk:
            continue
        buf += chunk
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            line = raw.decode("utf-8", errors="ignore").strip()
            if not line:
                continue
            lines.append(line)
            if line.startswith(prefixes):
                return lines
    return lines


def scan_networks(timeout: float = 12.0) -> dict:
    """Returns {"ok": True, "networks": [{"ssid","rssi","secured"}, ...]} (deduped by SSID,
    keeping the strongest signal, sorted strongest-first -- same "pick the best AP with this
    name" behavior as a normal OS WiFi picker) or {"ok": False, "error": "..."}."""
    with _lock:
        conn = _get_connection()
        if conn is None:
            return {"ok": False, "error": "ESP32 not detected on USB"}
        try:
            conn.reset_input_buffer()
            _send_line(conn, "WIFI_SCAN")
            lines = _read_lines_until(conn, ("WIFI_SCAN_DONE",), timeout)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    networks: dict[str, dict] = {}
    for line in lines:
        if not line.startswith("WIFI_NET|"):
            continue
        parts = line.split("|")
        if len(parts) != 4:
            continue
        _, ssid, rssi, secured = parts
        try:
            rssi_val = int(rssi)
        except ValueError:
            continue
        existing = networks.get(ssid)
        if existing is None or rssi_val > existing["rssi"]:
            networks[ssid] = {"ssid": ssid, "rssi": rssi_val, "secured": secured == "1"}

    result = sorted(networks.values(), key=lambda n: n["rssi"], reverse=True)
    return {"ok": True, "networks": result}


def set_wifi(ssid: str, password: str, timeout: float = 20.0) -> dict:
    """Returns {"ok": True, "ip": "..."} or {"ok": False, "error": "..."}."""
    if "|" in ssid or "|" in password or "\n" in ssid or "\n" in password:
        # The wire protocol is pipe-delimited/newline-terminated -- reject inputs that would
        # corrupt it rather than silently mangling the command sent to the firmware.
        return {"ok": False, "error": "ssid/password cannot contain '|' or a newline"}
    with _lock:
        conn = _get_connection()
        if conn is None:
            return {"ok": False, "error": "ESP32 not detected on USB"}
        try:
            conn.reset_input_buffer()
            _send_line(conn, f"WIFI_SET|{ssid}|{password}")
            lines = _read_lines_until(conn, ("WIFI_CONNECTED|", "WIFI_FAILED|"), timeout)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    for line in lines:
        if line.startswith("WIFI_CONNECTED|"):
            return {"ok": True, "ip": line.split("|", 1)[1]}
        if line.startswith("WIFI_FAILED|"):
            return {"ok": False, "error": line.split("|", 1)[1]}
    return {"ok": False, "error": "timed out waiting for the ESP32's response"}


def set_backend_host(host: str, timeout: float = 5.0) -> dict:
    """Sets (host non-empty) or clears (host == "") the fixed-backend override -- see
    esp32.ino's BACKEND_SET/BACKEND_CLEAR. A fixed host skips the ESP32's same-LAN UDP
    discovery entirely, which is what lets the board reach a backend on a *different*
    network than the one it's connected to (the backend must itself be reachable from
    there, e.g. via port-forward + DDNS or a VPN/tunnel -- this only points the board at it).
    Returns {"ok": True, "host": "..."} or {"ok": False, "error": "..."}."""
    if "|" in host or "\n" in host:
        return {"ok": False, "error": "host cannot contain '|' or a newline"}
    with _lock:
        conn = _get_connection()
        if conn is None:
            return {"ok": False, "error": "ESP32 not detected on USB"}
        try:
            conn.reset_input_buffer()
            _send_line(conn, f"BACKEND_SET|{host}")
            lines = _read_lines_until(conn, ("BACKEND_SET_OK|",), timeout)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    for line in lines:
        if line.startswith("BACKEND_SET_OK|"):
            return {"ok": True, "host": line.split("|", 1)[1]}
    return {"ok": False, "error": "timed out waiting for the ESP32's response"}


def get_backend_status(timeout: float = 5.0) -> dict:
    """Returns {"ok": True, "fixed": bool, "host": str, "url": str} or
    {"ok": False, "error": "..."}. `fixed` mirrors whether a BACKEND_SET override is active;
    `url` is whatever backendUrl the firmware is currently using either way (the fixed host,
    or its last same-LAN discovery result)."""
    with _lock:
        conn = _get_connection()
        if conn is None:
            return {"ok": False, "error": "ESP32 not detected on USB"}
        try:
            conn.reset_input_buffer()
            _send_line(conn, "BACKEND_STATUS")
            lines = _read_lines_until(conn, ("BACKEND_STATUS|",), timeout)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    for line in lines:
        if not line.startswith("BACKEND_STATUS|"):
            continue
        parts = line.split("|", 3)
        if len(parts) != 4:
            continue
        _, fixed, host, url = parts
        return {"ok": True, "fixed": fixed == "1", "host": host, "url": url}
    return {"ok": False, "error": "timed out waiting for the ESP32's response"}


def get_status(timeout: float = 5.0) -> dict:
    """Returns {"ok": True, "connected": bool, "ssid": str, "ip": str, "rssi": int} or
    {"ok": False, "error": "..."}."""
    with _lock:
        conn = _get_connection()
        if conn is None:
            return {"ok": False, "error": "ESP32 not detected on USB"}
        try:
            conn.reset_input_buffer()
            _send_line(conn, "WIFI_STATUS")
            lines = _read_lines_until(conn, ("WIFI_STATUS|",), timeout)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    for line in lines:
        if not line.startswith("WIFI_STATUS|"):
            continue
        parts = line.split("|")
        if len(parts) != 5:
            continue
        _, connected, ssid, ip, rssi = parts
        try:
            rssi_val = int(rssi)
        except ValueError:
            rssi_val = 0
        return {"ok": True, "connected": connected == "1", "ssid": ssid, "ip": ip, "rssi": rssi_val}
    return {"ok": False, "error": "timed out waiting for the ESP32's response"}
