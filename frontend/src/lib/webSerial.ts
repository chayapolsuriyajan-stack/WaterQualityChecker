/**
 * Browser-side USB WiFi provisioning, talking DIRECTLY to the ESP32 over the Web Serial API --
 * no backend involved. This replaces the old flow where the dashboard called main.py's
 * /wifi/* routes, which bridged to the board via wifi_serial.py (pyserial) on the machine
 * running python main.py. That meant WiFi provisioning only worked from the browser on the
 * SAME machine the backend process was running on, and depended on wifi_serial.py's
 * VID:PID auto-detect ever finding the right port.
 *
 * Web Serial (navigator.serial) lets the BROWSER itself open a direct connection to the
 * board's USB-serial port, with the user picking the exact device from the browser's own
 * native "Connect" picker (the same UX as python.microbit.org's Connect button) -- no
 * port-guessing, and it works from whatever machine the browser tab is open on, entirely
 * independent of whether a backend is running at all. The tradeoff: Web Serial is
 * Chromium-only (Chrome/Edge/Opera -- not Firefox/Safari) and requires a secure context
 * (https:// or http://localhost).
 *
 * Speaks the exact same line-based protocol as wifi_serial.py / esp32.ino's "USB WiFi
 * provisioning" section (WIFI_SCAN/WIFI_SET/WIFI_STATUS, BACKEND_SET/BACKEND_CLEAR/
 * BACKEND_STATUS/BACKEND_TEST, STATION_SET/STATION_CLEAR/STATION_STATUS) -- see esp32.ino
 * for the authoritative protocol definition.
 */
import type { WifiBackendStatus, WifiNetwork, WifiStationStatus, WifiStatus } from './types'

const BAUD_RATE = 115200
// Mirrors wifi_serial.py's _BOOT_SETTLE_SECONDS: opening a fresh connection resets most ESP32
// boards (DTR/RTS toggle), so give it a moment before the first command.
const BOOT_SETTLE_MS = 2000

export type SerialResult<T> = ({ ok: true } & T) | { ok: false; error: string }

let port: SerialPort | null = null
let reader: ReadableStreamDefaultReader<string> | null = null
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
let lineBuffer = ''
// Lines read but not yet consumed by a waiting call -- mirrors wifi_serial.py's per-call
// _read_lines_until, but since the browser has one long-lived read loop instead of a blocking
// per-call read, unclaimed lines (the firmware's free-form debug output) just accumulate here
// and get discarded on the next read cycle rather than kept around indefinitely.
let pendingLines: string[] = []
let disconnectListeners: Array<() => void> = []

export function isSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

export function isConnected(): boolean {
  return port !== null
}

export function onDisconnect(cb: () => void): () => void {
  disconnectListeners.push(cb)
  return () => {
    disconnectListeners = disconnectListeners.filter((f) => f !== cb)
  }
}

async function readLoop(p: SerialPort) {
  const textDecoder = new TextDecoderStream()
  // TextDecoderStream's .writable is WritableStream<BufferSource>, while SerialPort.readable
  // is ReadableStream<Uint8Array> -- pipeTo's generics are invariant so TS won't accept the
  // (perfectly valid at runtime) BufferSource-accepts-Uint8Array relationship without a cast.
  const readableClosed = p.readable!.pipeTo(textDecoder.writable as WritableStream<Uint8Array>).catch(() => {})
  reader = textDecoder.readable.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      lineBuffer += value
      let idx: number
      while ((idx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, idx).replace(/\r$/, '').trim()
        lineBuffer = lineBuffer.slice(idx + 1)
        if (line) pendingLines.push(line)
      }
    }
  } catch {
    // Port yanked mid-read (unplugged) -- handled by the 'disconnect' event below.
  } finally {
    await readableClosed
  }
}

/** Opens the browser's native device picker, then connects at 115200 baud. */
export async function connect(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isSupported()) {
    return { ok: false, error: 'Web Serial is not supported in this browser (needs Chrome, Edge, or Opera)' }
  }
  try {
    const selected = await navigator.serial.requestPort()
    await selected.open({ baudRate: BAUD_RATE })
    port = selected
    lineBuffer = ''
    pendingLines = []
    selected.addEventListener('disconnect', () => {
      void disconnect()
      disconnectListeners.forEach((cb) => cb())
    })
    void readLoop(selected)
    writer = selected.writable!.getWriter()
    await new Promise((resolve) => setTimeout(resolve, BOOT_SETTLE_MS))
    return { ok: true }
  } catch (err) {
    port = null
    // AbortError/NotFoundError -- the user closed the picker without choosing a device.
    if (err instanceof Error && (err.name === 'NotFoundError' || err.name === 'AbortError')) {
      return { ok: false, error: 'No device selected' }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function disconnect(): Promise<void> {
  try {
    await reader?.cancel()
  } catch {
    /* already closed */
  }
  try {
    writer?.releaseLock()
  } catch {
    /* already released */
  }
  try {
    await port?.close()
  } catch {
    /* already closed */
  }
  port = null
  reader = null
  writer = null
  lineBuffer = ''
  pendingLines = []
}

async function sendLine(line: string): Promise<void> {
  if (!writer) throw new Error('not connected')
  await writer.write(new TextEncoder().encode(line + '\n'))
}

/** Mirrors wifi_serial.py's _read_lines_until: collects lines until one starts with any of
 * `prefixes`, or `timeoutMs` elapses. */
async function readLinesUntil(prefixes: string[], timeoutMs: number): Promise<string[]> {
  const collected: string[] = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pendingLines.length > 0) {
      const line = pendingLines.shift()!
      collected.push(line)
      if (prefixes.some((p) => line.startsWith(p))) return collected
    } else {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  return collected
}

export async function scanNetworks(timeoutMs = 12000): Promise<SerialResult<{ networks: WifiNetwork[] }>> {
  if (!port) return { ok: false, error: 'not connected' }
  try {
    await sendLine('WIFI_SCAN')
    const lines = await readLinesUntil(['WIFI_SCAN_DONE'], timeoutMs)
    const byNetwork = new Map<string, WifiNetwork>()
    for (const line of lines) {
      if (!line.startsWith('WIFI_NET|')) continue
      const parts = line.split('|')
      if (parts.length !== 4) continue
      const [, ssid, rssiStr, secured] = parts
      const rssi = Number(rssiStr)
      if (Number.isNaN(rssi)) continue
      const existing = byNetwork.get(ssid)
      if (!existing || rssi > existing.rssi) {
        byNetwork.set(ssid, { ssid, rssi, secured: secured === '1' })
      }
    }
    return { ok: true, networks: [...byNetwork.values()].sort((a, b) => b.rssi - a.rssi) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function setWifi(ssid: string, password: string, timeoutMs = 20000): Promise<SerialResult<{ ip: string }>> {
  if (!port) return { ok: false, error: 'not connected' }
  if (ssid.includes('|') || password.includes('|') || ssid.includes('\n') || password.includes('\n')) {
    return { ok: false, error: "ssid/password cannot contain '|' or a newline" }
  }
  try {
    await sendLine(`WIFI_SET|${ssid}|${password}`)
    const lines = await readLinesUntil(['WIFI_CONNECTED|', 'WIFI_FAILED|'], timeoutMs)
    for (const line of lines) {
      if (line.startsWith('WIFI_CONNECTED|')) return { ok: true, ip: line.slice('WIFI_CONNECTED|'.length) }
      if (line.startsWith('WIFI_FAILED|')) return { ok: false, error: line.slice('WIFI_FAILED|'.length) }
    }
    return { ok: false, error: "timed out waiting for the ESP32's response" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function getStatus(timeoutMs = 5000): Promise<SerialResult<WifiStatus>> {
  if (!port) return { ok: false, error: 'not connected' }
  try {
    await sendLine('WIFI_STATUS')
    const lines = await readLinesUntil(['WIFI_STATUS|'], timeoutMs)
    for (const line of lines) {
      if (!line.startsWith('WIFI_STATUS|')) continue
      const parts = line.split('|')
      if (parts.length !== 5) continue
      const [, connected, ssid, ip, rssiStr] = parts
      return { ok: true, connected: connected === '1', ssid, ip, rssi: Number(rssiStr) || 0 }
    }
    return { ok: false, error: "timed out waiting for the ESP32's response" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function setBackendHost(
  host: string,
  apiKey: string,
  useHttps: boolean,
  timeoutMs = 5000,
): Promise<SerialResult<{ host: string }>> {
  if (!port) return { ok: false, error: 'not connected' }
  if (host.includes('|') || apiKey.includes('|') || host.includes('\n') || apiKey.includes('\n')) {
    return { ok: false, error: "host/apiKey cannot contain '|' or a newline" }
  }
  try {
    await sendLine(`BACKEND_SET|${host}|${apiKey}|${useHttps ? '1' : '0'}`)
    const lines = await readLinesUntil(['BACKEND_SET_OK|'], timeoutMs)
    for (const line of lines) {
      if (line.startsWith('BACKEND_SET_OK|')) return { ok: true, host: line.slice('BACKEND_SET_OK|'.length) }
    }
    return { ok: false, error: "timed out waiting for the ESP32's response" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function getBackendStatus(timeoutMs = 5000): Promise<SerialResult<WifiBackendStatus>> {
  if (!port) return { ok: false, error: 'not connected' }
  try {
    await sendLine('BACKEND_STATUS')
    const lines = await readLinesUntil(['BACKEND_STATUS|'], timeoutMs)
    for (const line of lines) {
      if (!line.startsWith('BACKEND_STATUS|')) continue
      const parts = line.split('|')
      if (parts.length !== 6) continue
      const [, fixed, host, url, hasApiKey, https] = parts
      return { ok: true, fixed: fixed === '1', host, url, hasApiKey: hasApiKey === '1', https: https === '1' }
    }
    return { ok: false, error: "timed out waiting for the ESP32's response" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function testBackendConnection(
  timeoutMs = 15000,
): Promise<SerialResult<{ reachable: boolean; httpCode: number; detail: string }>> {
  if (!port) return { ok: false, error: 'not connected' }
  try {
    await sendLine('BACKEND_TEST')
    const lines = await readLinesUntil(['BACKEND_TEST_OK|', 'BACKEND_TEST_FAILED|'], timeoutMs)
    for (const line of lines) {
      if (line.startsWith('BACKEND_TEST_OK|')) {
        const code = Number(line.slice('BACKEND_TEST_OK|'.length)) || 0
        return { ok: true, reachable: true, httpCode: code, detail: `HTTP ${code}` }
      }
      if (line.startsWith('BACKEND_TEST_FAILED|')) {
        return { ok: true, reachable: false, httpCode: 0, detail: line.slice('BACKEND_TEST_FAILED|'.length) }
      }
    }
    return { ok: false, error: "timed out waiting for the ESP32's response" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function setStationName(name: string, timeoutMs = 5000): Promise<SerialResult<{ name: string }>> {
  if (!port) return { ok: false, error: 'not connected' }
  if (name.includes('|') || name.includes('\n')) {
    return { ok: false, error: "station name cannot contain '|' or a newline" }
  }
  try {
    await sendLine(`STATION_SET|${name}`)
    const lines = await readLinesUntil(['STATION_SET_OK|', 'STATION_SET_FAILED|'], timeoutMs)
    for (const line of lines) {
      if (line.startsWith('STATION_SET_OK|')) return { ok: true, name: line.slice('STATION_SET_OK|'.length) }
      if (line.startsWith('STATION_SET_FAILED|')) return { ok: false, error: line.slice('STATION_SET_FAILED|'.length) }
    }
    return { ok: false, error: "timed out waiting for the ESP32's response" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function clearStationName(timeoutMs = 5000): Promise<SerialResult<{ name: string }>> {
  if (!port) return { ok: false, error: 'not connected' }
  try {
    await sendLine('STATION_CLEAR')
    const lines = await readLinesUntil(['STATION_SET_OK|'], timeoutMs)
    for (const line of lines) {
      if (line.startsWith('STATION_SET_OK|')) return { ok: true, name: line.slice('STATION_SET_OK|'.length) }
    }
    return { ok: false, error: "timed out waiting for the ESP32's response" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function getStationStatus(timeoutMs = 5000): Promise<SerialResult<WifiStationStatus>> {
  if (!port) return { ok: false, error: 'not connected' }
  try {
    await sendLine('STATION_STATUS')
    const lines = await readLinesUntil(['STATION_STATUS|'], timeoutMs)
    for (const line of lines) {
      if (!line.startsWith('STATION_STATUS|')) continue
      return { ok: true, name: line.slice('STATION_STATUS|'.length) }
    }
    return { ok: false, error: "timed out waiting for the ESP32's response" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- Minimal Web Serial API ambient types -----------------------------------------------
// Not yet part of TypeScript's bundled DOM lib, and we'd rather not pull in a whole
// @types/w3c-web-serial dependency for the handful of members this file actually uses.
declare global {
  interface SerialPort extends EventTarget {
    readonly readable: ReadableStream<Uint8Array> | null
    readonly writable: WritableStream<Uint8Array> | null
    open(options: { baudRate: number }): Promise<void>
    close(): Promise<void>
    addEventListener(type: 'disconnect', listener: () => void): void
  }
  interface Serial extends EventTarget {
    requestPort(): Promise<SerialPort>
  }
  interface Navigator {
    readonly serial: Serial
  }
}
