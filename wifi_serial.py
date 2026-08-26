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

# Common ESP32 dev-board USB-to-serial chip VID:PID pairs. Not exhaustive -- boards vary -- but
# covers the identifiers on the overwhelming majority of ESP32 dev boards, including the
# native USB CDC some newer boards (ESP32-S2/S3/C3, "USB-JTAG/serial") expose directly with no
# separate USB-to-serial chip at all.
KNOWN_VID_PID = {
    (0x10C4, 0xEA60),  # Silicon Labs CP2102/CP2104/CP2102N (same PID across that family)
    (0x1A86, 0x7523),  # QinHeng CH340
    (0x1A86, 0x5523),  # QinHeng CH341 (some CH340 clones/knockoffs report this PID instead)
    (0x1A86, 0x55D4),  # QinHeng CH9102 (newer CH340 variant, some ESP32-S3 boards)
    (0x0403, 0x6001),  # FTDI FT232R (a few ESP32 boards use FTDI instead of CP210x/CH34x)
    (0x0403, 0x6015),  # FTDI FT231X/FT230X
    (0x303A, 0x1001),  # Espressif native USB-JTAG/serial (ESP32-S2/S3/C3 built-in USB, no
                        # separate USB-to-serial chip -- the board enumerates as this directly)
    (0x303A, 0x0002),  # Espressif native USB CDC-ACM, alternate PID seen on some S3/C3 boards
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
    chip. None if pyserial isn't installed or nothing matches.

    Falls back to "the only serial port currently present" when KNOWN_VID_PID doesn't match
    anything -- that list is inherently incomplete (new chip revisions, unusual clones,
    boards we've never seen), but a machine plugged into exactly one serial device is, in
    practice, almost always plugged into the ESP32 specifically for this workflow. Skipped
    when there's more than one port, since guessing wrong there could talk to the wrong
    device instead of just failing closed.
    """
    if serial is None:
        return None
    if _configured_port:
        return _configured_port
    ports = list(serial.tools.list_ports.comports())
    for p in ports:
        if (p.vid, p.pid) in KNOWN_VID_PID:
            return p.device
    if len(ports) == 1:
        return ports[0].device
    return None


def list_ports() -> list[dict]:
    """Every serial port currently visible to the OS, for diagnosing a failed find_port() --
    e.g. "the board enumerated as a port but its chip isn't in KNOWN_VID_PID, here's what's
    actually there so a human can set webconfig.json's esp32SerialPort explicitly"."""
    if serial is None:
        return []
    return [
        {
            "device": p.device,
            "description": p.description,
            "vid": f"{p.vid:04X}" if p.vid is not None else None,
            "pid": f"{p.pid:04X}" if p.pid is not None else None,
        }
        for p in serial.tools.list_ports.comports()
    ]


def _not_detected_error() -> str:
    """Builds the "ESP32 not detected" error with whatever ports ARE visible, if any -- so a
    board that enumerated but didn't match KNOWN_VID_PID (or a genuinely wrong port) is
    diagnosable from the error message alone instead of just a dead end."""
    ports = list_ports()
    if not ports:
        return "ESP32 not detected on USB (no serial ports found at all -- check the cable/port)"
    seen = ", ".join(f"{p['device']} ({p['description']})" for p in ports)
    return (
        "ESP32 not detected on USB (none of the visible ports matched a known ESP32 chip -- "
        f"seen: {seen}. If one of these is the board, set webconfig.json's esp32SerialPort "
        "to it explicitly)"
    )


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
            return {"ok": False, "error": _not_detected_error()}
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
            return {"ok": False, "error": _not_detected_error()}
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


def set_backend_host(host: str, api_key: str = "", use_https: bool = False, timeout: float = 5.0) -> dict:
    """Sets (host non-empty) or clears (host == "") the fixed-backend override -- see
    esp32.ino's BACKEND_SET/BACKEND_CLEAR. A fixed host skips the ESP32's same-LAN UDP
    discovery entirely, which is what lets the board reach a backend on a *different*
    network than the one it's connected to (the backend must itself be reachable from
    there, e.g. via port-forward + DDNS or a VPN/tunnel -- this only points the board at it).

    `api_key` should match main.py's webconfig.json `updateApiKey` (the board sends it back
    as the X-API-Key header on every /update POST) and `use_https` switches the POST to
    main.py's HTTPS listener -- set both together whenever the backend might be reached over
    the open internet, since api_key sent over plain HTTP there is sent in cleartext.
    Returns {"ok": True, "host": "..."} or {"ok": False, "error": "..."}."""
    if any("|" in v or "\n" in v for v in (host, api_key)):
        return {"ok": False, "error": "host/api_key cannot contain '|' or a newline"}
    with _lock:
        conn = _get_connection()
        if conn is None:
            return {"ok": False, "error": _not_detected_error()}
        try:
            conn.reset_input_buffer()
            _send_line(conn, f"BACKEND_SET|{host}|{api_key}|{1 if use_https else 0}")
            lines = _read_lines_until(conn, ("BACKEND_SET_OK|",), timeout)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    for line in lines:
        if line.startswith("BACKEND_SET_OK|"):
            return {"ok": True, "host": line.split("|", 1)[1]}
    return {"ok": False, "error": "timed out waiting for the ESP32's response"}


def get_backend_status(timeout: float = 5.0) -> dict:
    """Returns {"ok": True, "fixed": bool, "host": str, "url": str, "hasApiKey": bool,
    "https": bool} or {"ok": False, "error": "..."}. `fixed` mirrors whether a BACKEND_SET
    override is active; `url` is whatever backendUrl the firmware is currently using either
    way (the fixed host, or its last same-LAN discovery result). The API key itself is never
    echoed back over serial (same as the WiFi password never is) -- only whether one is set."""
    with _lock:
        conn = _get_connection()
        if conn is None:
            return {"ok": False, "error": _not_detected_error()}
        try:
            conn.reset_input_buffer()
            _send_line(conn, "BACKEND_STATUS")
            lines = _read_lines_until(conn, ("BACKEND_STATUS|",), timeout)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    for line in lines:
        if not line.startswith("BACKEND_STATUS|"):
            continue
        parts = line.split("|")
        if len(parts) != 6:
            continue
        _, fixed, host, url, has_api_key, https = parts
        return {
            "ok": True,
            "fixed": fixed == "1",
            "host": host,
            "url": url,
            "hasApiKey": has_api_key == "1",
            "https": https == "1",
        }
    return {"ok": False, "error": "timed out waiting for the ESP32's response"}


def test_backend_connection(timeout: float = 15.0) -> dict:
    """Has the ESP32 itself GET /update/health against whatever backend it's currently
    configured to use (fixed host or last same-LAN discovery result -- see esp32.ino's
    BACKEND_TEST), through its own WiFi/DNS/TLS stack, so this actually verifies the path the
    board's real /update POSTs will take (not just this machine's). `timeout` is generous
    (default 15s, vs. the ~5s used elsewhere) since a TLS handshake plus a possibly-slow
    off-LAN round trip both add real latency on top of the USB round trip itself.
    Returns {"ok": True, "reachable": bool, "httpCode": int, "detail": str} (reachable=False
    with httpCode<=0 for a connection-level failure, e.g. DNS/TCP/TLS; reachable=True with a
    non-2xx httpCode for a server-level rejection, e.g. a wrong API key) or
    {"ok": False, "error": "..."} if the ESP32 itself couldn't be reached over USB."""
    with _lock:
        conn = _get_connection()
        if conn is None:
            return {"ok": False, "error": _not_detected_error()}
        try:
            conn.reset_input_buffer()
            _send_line(conn, "BACKEND_TEST")
            lines = _read_lines_until(conn, ("BACKEND_TEST_OK|", "BACKEND_TEST_FAILED|"), timeout)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    for line in lines:
        if line.startswith("BACKEND_TEST_OK|"):
            code_str = line.split("|", 1)[1]
            try:
                code = int(code_str)
            except ValueError:
                code = 0
            return {"ok": True, "reachable": True, "httpCode": code, "detail": f"HTTP {code}"}
        if line.startswith("BACKEND_TEST_FAILED|"):
            detail = line.split("|", 1)[1]
            return {"ok": True, "reachable": False, "httpCode": 0, "detail": detail}
    return {"ok": False, "error": "timed out waiting for the ESP32's response"}


def get_status(timeout: float = 5.0) -> dict:
    """Returns {"ok": True, "connected": bool, "ssid": str, "ip": str, "rssi": int} or
    {"ok": False, "error": "..."}."""
    with _lock:
        conn = _get_connection()
        if conn is None:
            return {"ok": False, "error": _not_detected_error()}
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
