# Remove UDP Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the ESP32 firmware's UDP same-LAN backend-discovery path entirely, requiring the existing `BACKEND_SET` fixed-host override instead — sub-project #1 of the Vercel migration effort.

**Architecture:** Single-file change confined to `firmware/esp32/esp32.ino`. Deletes `discoverBackend()` and its supporting declarations, simplifies `setup()`/`loop()` to rely solely on `applyBackendHost()` (already exists, already handles "no host configured" gracefully), and discards the currently-uncommitted hardcoded Vercel URL in favor of runtime `BACKEND_SET` configuration.

**Tech Stack:** Arduino/C++ (ESP32), no test framework — no automated test suite exists for this file.

## Global Constraints

- No changes to `main.py`, the frontend, or `google_apps_script.gs` — firmware-only.
- `main.py`'s own UDP listener (`DiscoveryProtocol`, port 8888) is explicitly untouched — out of scope for this sub-project.
- The backend address is configured at runtime via `BACKEND_SET` (already-existing mechanism), never hardcoded into the sketch.
- No test framework exists for this file; verification is manual (`grep`-based symbol checks, plus hardware verification if available, exactly as this project's other recent firmware changes have done).

---

### Task 1: Remove `discoverBackend()` and wire `setup()`/`loop()` to rely solely on `BACKEND_SET`

**Files:**
- Modify: `firmware/esp32/esp32.ino` (declarations block ~line 195-217, `WIFI_SET` success handler ~line 369, `discoverBackend()` + `setup()` ~line 565-678, `loop()`'s backend-recovery block ~line 686-702)

**Interfaces:**
- Consumes: `applyBackendHost()`, `currentBackendHost`, `backendKnown`, `consecutiveFailures` (all pre-existing, unchanged signatures).
- Produces: nothing new — this task only removes code and simplifies two existing functions' bodies. No other file *depends* on `discoverBackend()`, `discoveryPort`, `discoveryRequest`, `discoveryReply`, or `discoveryUdp` (confirmed via repo-wide grep before writing this plan). `main.py:1516` has one doc-comment mentioning `discoverBackend()` by name for cross-reference — harmless and explicitly out of scope (no `main.py` changes per Global Constraints), left as a known, accepted minor staleness rather than fixed here.

- [ ] **Step 1: Discard the uncommitted hardcoded backend URL**

The working tree currently has an uncommitted change to `discoverBackend()` that hardcodes `backendUrl = "https://water-quality-checker-five.vercel.app/update"`. This plan replaces that function entirely (Step 4 below), so first discard just that uncommitted diff to start from a clean base:

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git diff firmware/esp32/esp32.ino
```

Confirm the diff shown matches what's described above (UDP discovery commented out inside `discoverBackend()`, replaced with the hardcoded Vercel URL and `found = true`). If it matches, discard it:

```bash
git checkout -- firmware/esp32/esp32.ino
```

If the diff does NOT match this description (e.g. it's already been committed, or contains unrelated changes), STOP and report — don't blindly discard something unexpected.

- [ ] **Step 2: Remove the discovery declarations block**

Open `firmware/esp32/esp32.ino`. Find this exact block (search for `const unsigned int discoveryPort = 8888;`):

```cpp
// Backend IP is normally found at runtime via UDP broadcast discovery (see discoverBackend())
// instead of being hardcoded, so the sketch keeps working after the backend PC's
// DHCP-assigned IP changes. main.py must be running its discovery listener on this port.
// UDP broadcast never crosses networks though -- it only ever finds a backend sharing the
// board's own subnet. When the board's WiFi network and the backend PC's network differ (see
// BACKEND_SET below), a fixed host/IP set via USB overrides discovery entirely.
const unsigned int discoveryPort = 8888;
const char* discoveryRequest = "HYDRO_DISCOVER";
const char* discoveryReply = "HYDRO_HERE";
WiFiUDP discoveryUdp;
```

Replace it with:

```cpp
// Same-LAN UDP broadcast discovery was removed on this branch (see
// docs/superpowers/specs/2026-09-04-remove-udp-discovery-design.md) -- this board's backend
// is never on its own LAN once it's a Vercel-hosted deployment, so discovery could never have
// found it anyway. A fixed backend host, set once via BACKEND_SET over USB (or the dashboard's
// WiFi panel), is now the only way this board learns where to POST readings -- see
// applyBackendHost()/handleBackendSet() below.
```

- [ ] **Step 3: Remove the now-unused `WiFiUdp.h` include**

Find `#include <WiFiUdp.h>` (near the top of the file, alongside the other includes). Confirm nothing else in the file references `WiFiUDP` (Step 2 removed the only usage):

```bash
grep -n "WiFiUDP\|WiFiUdp" firmware/esp32/esp32.ino
```

Expected: no matches (Step 2 already removed the one declaration). Delete the `#include <WiFiUdp.h>` line.

- [ ] **Step 4: Delete `discoverBackend()` entirely**

Find and delete this whole function (search for `bool discoverBackend(unsigned long timeoutMs = 3000) {`):

```cpp
// Broadcasts a discovery request and waits for the backend to reply. On success,
// sets backendUrl from the reply's source IP. Returns false (and leaves backendUrl
// untouched) if nothing answers within timeoutMs.
bool discoverBackend(unsigned long timeoutMs = 3000) {
  bool found = false;
  // discoveryUdp.begin(discoveryPort);
  // discoveryUdp.beginPacket(IPAddress(255, 255, 255, 255), discoveryPort);
  // discoveryUdp.write((const uint8_t*)discoveryRequest, strlen(discoveryRequest));
  // discoveryUdp.endPacket();
  
  // unsigned long start = millis();
  // while (millis() - start < timeoutMs) {
  //   int packetSize = discoveryUdp.parsePacket();
  //   if (packetSize > 0) {
  //     char buf[32];
  //     int len = discoveryUdp.read(buf, sizeof(buf) - 1);
  //     buf[len] = 0;
  //     if (strncmp(buf, discoveryReply, strlen(discoveryReply)) == 0) {
  //       IPAddress backendIP = discoveryUdp.remoteIP();
  //       backendUrl = String("http://") + backendIP.toString() + ":" + backendPort + "/update";
  //       Serial.print("Discovered backend at: ");
  //       Serial.println(backendUrl);
  //       found = true;
  //       break;
  //     }
  //   }
  //   delay(20);
  // }
  // discoveryUdp.stop();

  backendUrl = String("https://water-quality-checker-five.vercel.app/update");
  Serial.print("Discovered backend at: ");
  Serial.println(backendUrl);
  found = true;
  return found;
}
```

(If Step 1 was applied correctly, this function should already be back to its pre-hardcode state — the real UDP broadcast body, not the commented-out+hardcoded version shown above for reference. Delete whatever the actual current function body is, in full, regardless of which state it's in.)

- [ ] **Step 5: Simplify `setup()`'s backend-acquisition block**

Find this block inside `setup()` (search for `if (currentBackendHost.length() > 0) {` — it directly follows the MDNS setup):

```cpp
  if (currentBackendHost.length() > 0) {
    // Fixed backend configured over USB (possibly on a different network) -- skip LAN
    // discovery entirely.
    applyBackendHost();
  } else {
    Serial.println("Searching for backend server...");
    // Bounded (20s, not infinite -- same reasoning as the WiFi-connect wait above): a backend
    // may never answer at all (no main.py running anywhere, e.g. Google Sheets fallback used
    // as the only destination on purpose), and an unconditional wait here would hang setup()
    // forever, which would keep loop() -- and therefore the Sheets fallback and every sensor
    // read -- from ever running. Falls through to loop() either way; loop() keeps retrying
    // discovery on its own timer, so a backend that shows up later is still picked up.
    // backendKnown is set from `discovered` itself (not inferred from WiFi.status() afterward)
    // since WiFi could in principle drop mid-retry without discovery ever having succeeded.
    bool discovered = false;
    unsigned long backendWaitStart = millis();
    while (WiFi.status() == WL_CONNECTED && !discovered && millis() - backendWaitStart < 20000) {
      readSerialCommands();
      discovered = discoverBackend();
      if (!discovered) Serial.println("Backend not found, retrying...");
    }
    backendKnown = discovered;
    if (!discovered) {
      Serial.println("No backend found after 20s -- continuing without one. Sensor reads/Sheets fallback (if configured) proceed regardless; backend discovery keeps retrying in the background.");
    }
  }
```

Replace it with:

```cpp
  // No same-LAN discovery anymore (see the removed discoverBackend() above) -- applyBackendHost()
  // does the whole job now: sets backendUrl + backendKnown=true if a fixed host is configured,
  // or leaves backendKnown=false (sensor reads/Sheets fallback proceed regardless) if not.
  applyBackendHost();
  if (!backendKnown) {
    Serial.println("No backend configured. Use BACKEND_SET over USB (or the dashboard's WiFi panel) to set one -- sensor reads/Sheets fallback (if configured) proceed regardless in the meantime.");
  }
```

- [ ] **Step 6: Simplify `loop()`'s backend-recovery block**

Find this block inside `loop()` (search for `if (!backendKnown) {` — it's right after `lastBroadcastTime = currentMillis;`):

```cpp
    if (!backendKnown) {
      if (currentBackendHost.length() > 0) {
        // Fixed backend: nothing to rediscover, just resume posting to it. The failure
        // was presumably transient Wi-Fi/routing, not the backend's IP changing.
        applyBackendHost();
        consecutiveFailures = 0;
      } else if (discoverBackend()) {
        backendKnown = true;
        consecutiveFailures = 0;
      } else {
        Serial.println("Still searching for backend...");
      }
    }
```

Replace it with:

```cpp
    if (!backendKnown && currentBackendHost.length() > 0) {
      // Fixed backend: nothing to rediscover, just resume posting to it. The failure
      // was presumably transient Wi-Fi/routing, not the backend's IP changing.
      applyBackendHost();
      consecutiveFailures = 0;
    }
    // No fixed host at all: nothing to retry each tick (no discovery to fall back to
    // anymore) -- sensor reads/Sheets fallback below proceed regardless, same as before.
```

- [ ] **Step 7: Fix the stale "force UDP rediscovery" comment**

Find (search for `force UDP rediscovery`):

```cpp
    backendKnown = false; // force UDP rediscovery -- the backend's IP may differ on this network
```

Replace with:

```cpp
    backendKnown = false; // force applyBackendHost() to re-run on the next tick -- relevant if a
                           // fixed host is set and the board just moved to a different network
```

- [ ] **Step 8: Verify every discovery symbol is actually gone**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
grep -n "discoverBackend\|discoveryUdp\|discoveryPort\|discoveryRequest\|discoveryReply\|WiFiUDP\|WiFiUdp" firmware/esp32/esp32.ino
```

Expected: no output at all (zero matches). If anything matches, one of Steps 2-4 was missed or incomplete — go back and finish it before proceeding.

```bash
grep -n "backendKnown\|applyBackendHost" firmware/esp32/esp32.ino
```

Expected: matches only in `applyBackendHost()`'s own definition, `handleBackendSet`/`handleBackendClear` (unchanged, not touched by this plan), and the `setup()`/`loop()` call sites from Steps 5-6 — confirm no leftover reference to the deleted function.

- [ ] **Step 9: Hardware verification (if available)**

No automated test suite exists for this file. If you have the physical ESP32 board and can flash it:

1. Flash the updated sketch with no `BACKEND_SET` ever configured (fresh board, or one that's had `BACKEND_CLEAR` sent to it).
2. Confirm the Serial Monitor shows *"No backend configured. Use BACKEND_SET over USB..."* within a couple seconds of boot, NOT a 20-second discovery wait.
3. Send `BACKEND_SET|water-quality-checker-five.vercel.app|<any-test-key>|1` over the Serial Monitor (115200 baud).
4. Confirm the Serial Monitor shows `Using configured backend: https://water-quality-checker-five.vercel.app:8443/update` (or similar, matching `applyBackendHost()`'s existing URL-building logic) and that sensor reads continue on their normal 2s cadence throughout.

If you do NOT have hardware access in this environment, skip this step and report it as unconfirmed — the code-level checks in Step 8 are the available verification. Do not fabricate results.

- [ ] **Step 10: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add firmware/esp32/esp32.ino
git commit -m "Remove UDP backend discovery from firmware, require BACKEND_SET"
```

---

## Self-review notes

- **Spec coverage**: discovery declarations removed (Step 2), unused include removed (Step 3), `discoverBackend()` deleted (Step 4), `setup()` simplified (Step 5), `loop()` simplified (Step 6), stale comment fixed (Step 7), uncommitted hardcoded-URL diff discarded in favor of runtime `BACKEND_SET` configuration (Step 1). All spec sections covered. `main.py` untouched, as required.
- **Placeholder scan**: none found — every step has complete, exact code.
- **Type/symbol consistency**: `applyBackendHost()`, `backendKnown`, `currentBackendHost`, `consecutiveFailures` are all pre-existing symbols used exactly as they already exist elsewhere in the file (verified via the plan's own grep checks in Step 8) — no new functions introduced, so no cross-step signature-mismatch risk.
