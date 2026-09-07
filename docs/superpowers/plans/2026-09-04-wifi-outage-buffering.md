# WiFi-Outage Offline Data Buffering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen the ESP32 firmware's existing Google Sheets fallback buffer so it also captures readings during a genuine WiFi outage (not just a backend-down outage), grows its capacity to ~1 hour, includes flow, and drains recovered readings gradually instead of in one blocking burst.

**Architecture:** A single-file firmware change (`firmware/esp32/esp32.ino`). The existing circular buffer gains an explicit "oldest" index so it can be partially drained (not just fully cleared), a fourth data array for flow pulses, and a new uncalibrated flow-rate helper mirroring the existing uncalibrated-TDS helper. The `loop()` function's push/flush logic is rewired to (a) push on any live-delivery failure including WiFi being down, (b) flush a capped batch per tick, and (c) never discard the backlog just because the backend recovered.

**Tech Stack:** Arduino/C++ (ESP32), no test framework — this repo has no automated test suite on either the firmware or backend/frontend side (see `CLAUDE.md`).

## Global Constraints

- RAM-only buffer, no flash/reset-survival (explicitly out of scope per the design spec).
- Buffer capacity: 1800 entries (~1 hour at the existing 2000ms `broadcastInterval` cadence).
- Recovery flush: capped at 10 buffered readings sent per `sheetsFallbackInterval` (60000ms) tick, not the whole backlog at once.
- Buffer draining must be independent of backend recovery — a successful live backend POST must NOT clear or otherwise touch the fallback buffer.
- The buffered flow value sent to Google Sheets is `data.flowRate` (instantaneous L/min, computed with the nominal YF-S201 k-factor of 450 pulses/liter), matching `google_apps_script.gs`'s `doPost` contract and the live path's field name — never a raw pulse count.
- No backend (`main.py`) or frontend changes — this is entirely confined to `firmware/esp32/esp32.ino`.
- No test framework exists for this file; verification is manual, via Arduino IDE compile + Serial Monitor + checking the deployed Google Sheet.

---

### Task 1: Buffer capacity, flow tracking, and partial-drain support

**Files:**
- Modify: `firmware/esp32/esp32.ino:127-158` (the `dfrobotUncalibratedPpm` function and the buffer declarations/`sheetsFallbackBufferPush`/`sheetsFallbackBufferClear` functions immediately below it)

**Interfaces:**
- Produces: `sheetsFallbackFlowBuffer[sheetsFallbackBufferSize]` (new array), `sheetsFallbackBufferOldest` (new int, index of the oldest still-buffered entry), `nominalFlowRate(float pulses, float intervalSeconds) -> float`, `sheetsFallbackBufferPush(float temperature, float turbidity, float tdsVoltage, float flowPulses)` (gains a 4th parameter), `sheetsFallbackBufferAdvance(int n)` (new function — removes the `n` oldest entries after they've been sent), `sheetsFallbackBufferClear()` (unchanged signature, now also resets `sheetsFallbackBufferOldest`).
- Consumes: nothing new from elsewhere in the file — this task is purely additive/structural and does not change `loop()`'s behavior yet (Task 2 wires these into `loop()`).

This task alone does not change firmware behavior — the new/changed functions aren't called from `loop()` until Task 2. It's still independently reviewable: read through the buffer arithmetic and confirm it's correct in isolation before Task 2 depends on it.

- [ ] **Step 1: Read the current buffer code to confirm line numbers before editing**

Open `firmware/esp32/esp32.ino` and find this exact block (search for `const int sheetsFallbackBufferSize = 30;`):

```cpp
const int sheetsFallbackBufferSize = 30;
float sheetsFallbackTempBuffer[sheetsFallbackBufferSize];
float sheetsFallbackTurbBuffer[sheetsFallbackBufferSize];
float sheetsFallbackTdsVoltageBuffer[sheetsFallbackBufferSize];
int sheetsFallbackBufferCount = 0; // how many valid entries (caps at sheetsFallbackBufferSize)
int sheetsFallbackBufferNext = 0;  // next slot to write; wraps once the buffer is full

void sheetsFallbackBufferPush(float temperature, float turbidity, float tdsVoltage) {
  sheetsFallbackTempBuffer[sheetsFallbackBufferNext] = temperature;
  sheetsFallbackTurbBuffer[sheetsFallbackBufferNext] = turbidity;
  sheetsFallbackTdsVoltageBuffer[sheetsFallbackBufferNext] = tdsVoltage;
  sheetsFallbackBufferNext = (sheetsFallbackBufferNext + 1) % sheetsFallbackBufferSize;
  if (sheetsFallbackBufferCount < sheetsFallbackBufferSize) sheetsFallbackBufferCount++;
}

void sheetsFallbackBufferClear() {
  sheetsFallbackBufferCount = 0;
  sheetsFallbackBufferNext = 0;
}
```

If the actual file differs from this (different variable names, different surrounding code), STOP and report — don't guess at a different structure.

- [ ] **Step 2: Replace the block with the grown, flow-aware, partial-drain-capable version**

Replace the entire block from Step 1 with:

```cpp
// Sensors are read every broadcastInterval (2s), but each buffered reading becomes its own
// Apps Script call once we're able to send (see the flush loop in loop() below) -- bursting
// all of them at once is inconsiderate of Apps Script's per-call execution overhead, so sends
// are throttled to at most sheetsFallbackMaxSendPerTick per sheetsFallbackInterval tick (a
// trickle drain, not a burst -- see loop()'s flush block). Readings taken between flushes
// accumulate in a circular buffer (once full, the newest overwrites the oldest -- degrades to
// "most recent hour" instead of overflowing) so up to an hour-long outage (WiFi down, backend
// down, or both) is recovered in full, not just its last instant.
const int sheetsFallbackBufferSize = 1800; // ~1 hour at the 2s broadcastInterval cadence
float sheetsFallbackTempBuffer[sheetsFallbackBufferSize];
float sheetsFallbackTurbBuffer[sheetsFallbackBufferSize];
float sheetsFallbackTdsVoltageBuffer[sheetsFallbackBufferSize];
float sheetsFallbackFlowBuffer[sheetsFallbackBufferSize]; // raw flowPulses count for that reading
int sheetsFallbackBufferCount = 0;  // how many valid entries (caps at sheetsFallbackBufferSize)
int sheetsFallbackBufferNext = 0;   // next slot to write; wraps once the buffer is full
int sheetsFallbackBufferOldest = 0; // index of the oldest still-buffered (not yet sent) entry

void sheetsFallbackBufferPush(float temperature, float turbidity, float tdsVoltage, float flowPulses) {
  sheetsFallbackTempBuffer[sheetsFallbackBufferNext] = temperature;
  sheetsFallbackTurbBuffer[sheetsFallbackBufferNext] = turbidity;
  sheetsFallbackTdsVoltageBuffer[sheetsFallbackBufferNext] = tdsVoltage;
  sheetsFallbackFlowBuffer[sheetsFallbackBufferNext] = flowPulses;
  bool wasFull = (sheetsFallbackBufferCount == sheetsFallbackBufferSize);
  sheetsFallbackBufferNext = (sheetsFallbackBufferNext + 1) % sheetsFallbackBufferSize;
  if (wasFull) {
    // Buffer was already full -- this push just overwrote the oldest entry, so the new
    // oldest is the next slot over.
    sheetsFallbackBufferOldest = (sheetsFallbackBufferOldest + 1) % sheetsFallbackBufferSize;
  } else {
    sheetsFallbackBufferCount++;
  }
}

void sheetsFallbackBufferClear() {
  sheetsFallbackBufferCount = 0;
  sheetsFallbackBufferNext = 0;
  sheetsFallbackBufferOldest = 0;
}

// Removes the `n` oldest entries after they've been sent (or at least attempted -- matches
// this sketch's existing fire-and-forget posture elsewhere, not a retry queue). Used for a
// PARTIAL drain (see loop()'s flush block, capped at sheetsFallbackMaxSendPerTick per tick) --
// sheetsFallbackBufferClear() above is only for a FULL reset (fresh WIFI_SET, etc.), never
// called from the trickle-flush path itself.
void sheetsFallbackBufferAdvance(int n) {
  sheetsFallbackBufferOldest = (sheetsFallbackBufferOldest + n) % sheetsFallbackBufferSize;
  sheetsFallbackBufferCount -= n;
  if (sheetsFallbackBufferCount < 0) sheetsFallbackBufferCount = 0;
}
```

- [ ] **Step 3: Add the uncalibrated flow-rate helper**

Directly below `dfrobotUncalibratedPpm`'s closing brace (the function immediately above the block just edited — search `float dfrobotUncalibratedPpm(float voltage, float temperatureC) {` and find its `}`), add:

```cpp
// Uncalibrated flow rate (L/min) for the Sheets fallback path only -- mirrors
// dfrobotUncalibratedPpm's reasoning for TDS just above: the real k-factor lives in
// calibration.json on the backend PC, unreachable from here, so this uses the nominal
// YF-S201 default (450 pulses/liter, matching main.py's _default_calibration()) rather than
// omitting flow entirely. `pulses` is the raw count accumulated over `intervalSeconds` (the
// same reading-to-reading gap flowPulses always represents elsewhere in this sketch).
float nominalFlowRate(float pulses, float intervalSeconds) {
  float liters = pulses / 450.0;
  return liters / (intervalSeconds / 60.0);
}
```

- [ ] **Step 4: Verify the file still opens correctly and the edit landed cleanly**

There's no compiler available in this environment (`arduino-cli` is not installed) and no automated test suite for this file. Verify by reading the edited region back and confirming:
- The block matches Step 2's code exactly (search for `sheetsFallbackBufferAdvance` and `sheetsFallbackBufferOldest` — both should now exist).
- `nominalFlowRate` exists directly after `dfrobotUncalibratedPpm`.
- No other part of the file references `sheetsFallbackBufferPush(` with only 3 arguments (search for `sheetsFallbackBufferPush(` across the whole file — at this point in the plan there should be exactly one call site, inside `loop()`, and it still has the OLD 3-argument form until Task 2 updates it; note this expected call site for Task 2, don't fix it in this task).

If you have access to the Arduino IDE or `arduino-cli` in your environment (unlike this plan's authoring environment), a real compile check is stronger evidence — run it if available and report the result, but its absence is not a blocker for this task.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add firmware/esp32/esp32.ino
git commit -m "Grow ESP32 Sheets-fallback buffer to 1hr capacity, add flow tracking + partial drain"
```

---

### Task 2: Wire WiFi-outage capture and trickle-flush into loop()

**Files:**
- Modify: `firmware/esp32/esp32.ino` — the `loop()` function's backend-POST and Sheets-fallback block (currently spans roughly lines 695-816; re-locate by searching for `bool backendPostFailed = false;` and reading to the end of the enclosing `if (backendKnown) { ... }` block, then the Sheets-fallback `if (...)` block immediately after it)

**Interfaces:**
- Consumes: `sheetsFallbackBufferPush(temperature, turbidity, tdsVoltage, flowPulses)` (4-arg form from Task 1), `sheetsFallbackBufferAdvance(n)` (Task 1), `sheetsFallbackBufferOldest`/`sheetsFallbackBufferCount`/`sheetsFallbackBufferSize`/`sheetsFallbackFlowBuffer`/`sheetsFallbackTempBuffer`/`sheetsFallbackTurbBuffer`/`sheetsFallbackTdsVoltageBuffer` (Task 1), `nominalFlowRate(pulses, intervalSeconds)` (Task 1), `dfrobotUncalibratedPpm` (pre-existing), `broadcastInterval` (pre-existing constant, currently 2000ms), `flowPulses` (pre-existing `unsigned long` local variable, in scope at this point in `loop()`).
- Produces: nothing new for later tasks — this is the final integration task for this feature.

- [ ] **Step 1: Locate and read the current block to confirm structure before editing**

Search for `bool backendPostFailed = false;` in `firmware/esp32/esp32.ino`. Read from there through the end of the Sheets-fallback `if` block that follows the `if (backendKnown) { ... }` block (it ends with `sheetsFallbackBufferClear();` followed by two closing braces `}\n}` before `void loop()`'s own closing brace, or similar — read carefully to find the true end). Confirm the block looks like this shape (paraphrased structure, exact wording may differ slightly from what's quoted here — if it differs substantially, STOP and report rather than guessing):

- An `if (backendKnown) { if (WiFi.status() == WL_CONNECTED) { ...POST... } else { ...skip... } }` block that sets `backendPostFailed` and, on POST success, calls `sheetsFallbackBufferClear()`.
- Immediately after, an `if ((!backendKnown || backendPostFailed) && WiFi.status() == WL_CONNECTED) { ...push + flush... }` block.

- [ ] **Step 2: Remove the early-clear-on-backend-recovery**

Inside the `if (httpCode > 0) { ... }` success branch (the one that also does `consecutiveFailures = 0;`), find and DELETE these lines:

```cpp
          // The backend has caught up to the present again -- readings buffered for the
          // Sheets fallback while it was down have served their purpose (or will on the next
          // flush window); clear so a late-arriving flush doesn't resend now-stale readings.
          sheetsFallbackBufferClear();
```

Leave `consecutiveFailures = 0;` and everything else in that success branch untouched. After this edit, a successful backend POST no longer touches the fallback buffer in any way.

- [ ] **Step 3: Replace the push+flush block**

Find and replace this entire block (search for the comment `// Google Sheets fallback: buffers every reading taken while the backend is unreachable`):

```cpp
    // Google Sheets fallback: buffers every reading taken while the backend is unreachable
    // (never discovered, or this attempt's POST just failed) so readings aren't silently
    // dropped during a backend outage, then flushes the whole buffer -- one Apps Script POST
    // per buffered reading, matching google_apps_script.gs's doPost single-reading JSON shape
    // -- no more than once per sheetsFallbackInterval so a long outage doesn't fire a burst of
    // calls too often. Needs real internet (not just LAN) and sheetsWebhookUrl filled in above.
    if ((!backendKnown || backendPostFailed) && WiFi.status() == WL_CONNECTED) {
      sheetsFallbackBufferPush(temperatureC, turbidityADC, tdsVoltage);

      if (currentMillis - lastSheetsFallbackPostTime >= sheetsFallbackInterval && sheetsFallbackBufferCount > 0) {
        lastSheetsFallbackPostTime = currentMillis;

        // Oldest entry is at sheetsFallbackBufferNext once the buffer has wrapped (that slot
        // is next to be overwritten); while still filling up for the first time, oldest is
        // just index 0.
        int oldestIdx = (sheetsFallbackBufferCount < sheetsFallbackBufferSize) ? 0 : sheetsFallbackBufferNext;
        int sent = 0;
        for (int i = 0; i < sheetsFallbackBufferCount; i++) {
          int idx = (oldestIdx + i) % sheetsFallbackBufferSize;

          // TDS: uncalibrated ppm (see dfrobotUncalibratedPpm's header comment above), not the
          // raw sensor voltage -- the sheet's TDS column is always ppm-shaped with no separate
          // raw-voltage column to backfill from later, unlike turbidity's raw ADC.
          StaticJsonDocument<240> sheetsDoc; // was <192> -- station (up to 40 chars) needs the headroom
          sheetsDoc["temperature"] = sheetsFallbackTempBuffer[idx];
          sheetsDoc["turbidity"] = sheetsFallbackTurbBuffer[idx];
          sheetsDoc["tds"] = dfrobotUncalibratedPpm(sheetsFallbackTdsVoltageBuffer[idx], sheetsFallbackTempBuffer[idx]);
          if (currentStationName.length() > 0) {
            sheetsDoc["station"] = currentStationName;
          }

          String sheetsPayload;
          serializeJson(sheetsDoc, sheetsPayload);

          WiFiClientSecure sheetsClient;
          // Apps Script's cert is a real public CA in practice, but this board has no CA
          // store to validate against -- same accepted tradeoff as the fixed-backend HTTPS
          // path above (encrypts in transit, doesn't authenticate the server).
          sheetsClient.setInsecure();
          HTTPClient sheetsHttp;
          sheetsHttp.begin(sheetsClient, sheetsWebhookUrl);
          sheetsHttp.addHeader("Content-Type", "application/json");
          int sheetsHttpCode = sheetsHttp.POST(sheetsPayload);
          sheetsHttp.end();
          if (sheetsHttpCode > 0) sent++;
        }
        Serial.printf("Sheets fallback flush: %d/%d buffered readings sent\n", sent, sheetsFallbackBufferCount);

        // Sent (or at least attempted) -- start the next window's buffer fresh regardless of
        // per-reading success, matching the existing fire-and-forget posture elsewhere in this
        // sketch (a lost reading here is already best-effort).
        sheetsFallbackBufferClear();
      }
    }
```

with:

```cpp
    // Google Sheets fallback: buffers every reading taken during ANY live-delivery failure --
    // backend never discovered, this attempt's POST just failed, OR WiFi itself is down (a
    // genuine WiFi outage, not just a backend outage) -- so readings aren't silently dropped
    // either way. Pushing is unconditional on delivery failure; flushing is a SEPARATE
    // condition gated only on WiFi actually being up right now, so the buffer keeps draining
    // even after the backend has already recovered and live readings are flowing normally
    // again (see the removed sheetsFallbackBufferClear() above -- backend recovery no longer
    // touches this buffer at all, since /update has no way to accept backfilled historical
    // readings; only this Sheets path can receive the backlog).
    bool liveDeliveryFailed = (!backendKnown || backendPostFailed) || (WiFi.status() != WL_CONNECTED);
    if (liveDeliveryFailed) {
      sheetsFallbackBufferPush(temperatureC, turbidityADC, tdsVoltage, (float)flowPulses);
    }

    // Flush is throttled to at most sheetsFallbackMaxSendPerTick buffered readings per
    // sheetsFallbackInterval tick -- a TRICKLE drain, not a burst -- so a full ~1hr backlog
    // (up to sheetsFallbackBufferSize entries) doesn't fire hundreds of blocking HTTP POSTs
    // back-to-back and delay live readings. Needs real internet (not just LAN) and
    // sheetsWebhookUrl filled in above. Runs independent of liveDeliveryFailed above, purely
    // on "is WiFi up and is there a backlog" -- so it keeps draining post-recovery too.
    if (WiFi.status() == WL_CONNECTED && currentMillis - lastSheetsFallbackPostTime >= sheetsFallbackInterval && sheetsFallbackBufferCount > 0) {
      lastSheetsFallbackPostTime = currentMillis;

      int toSend = min(sheetsFallbackMaxSendPerTick, sheetsFallbackBufferCount);
      int sent = 0;
      for (int i = 0; i < toSend; i++) {
        int idx = (sheetsFallbackBufferOldest + i) % sheetsFallbackBufferSize;

        // TDS: uncalibrated ppm (see dfrobotUncalibratedPpm's header comment above), not the
        // raw sensor voltage -- the sheet's TDS column is always ppm-shaped with no separate
        // raw-voltage column to backfill from later, unlike turbidity's raw ADC. Flow: same
        // uncalibrated-nominal-k reasoning via nominalFlowRate (see its header comment) --
        // sends data.flowRate (L/min), matching google_apps_script.gs's doPost contract and
        // the live /update path's field name, never a raw pulse count.
        StaticJsonDocument<240> sheetsDoc; // was <192> -- station (up to 40 chars) needs the headroom
        sheetsDoc["temperature"] = sheetsFallbackTempBuffer[idx];
        sheetsDoc["turbidity"] = sheetsFallbackTurbBuffer[idx];
        sheetsDoc["tds"] = dfrobotUncalibratedPpm(sheetsFallbackTdsVoltageBuffer[idx], sheetsFallbackTempBuffer[idx]);
        sheetsDoc["flowRate"] = nominalFlowRate(sheetsFallbackFlowBuffer[idx], broadcastInterval / 1000.0);
        if (currentStationName.length() > 0) {
          sheetsDoc["station"] = currentStationName;
        }

        String sheetsPayload;
        serializeJson(sheetsDoc, sheetsPayload);

        WiFiClientSecure sheetsClient;
        // Apps Script's cert is a real public CA in practice, but this board has no CA
        // store to validate against -- same accepted tradeoff as the fixed-backend HTTPS
        // path above (encrypts in transit, doesn't authenticate the server).
        sheetsClient.setInsecure();
        HTTPClient sheetsHttp;
        sheetsHttp.begin(sheetsClient, sheetsWebhookUrl);
        sheetsHttp.addHeader("Content-Type", "application/json");
        int sheetsHttpCode = sheetsHttp.POST(sheetsPayload);
        sheetsHttp.end();
        if (sheetsHttpCode > 0) sent++;
      }
      Serial.printf("Sheets fallback flush: %d/%d sent this tick, %d remaining\n", sent, toSend, sheetsFallbackBufferCount - toSend);

      // Advance past everything ATTEMPTED this tick (sent or not) -- matches this sketch's
      // existing fire-and-forget posture, not a retry queue. A partial drain: whatever's left
      // stays buffered for the next tick, 60s later.
      sheetsFallbackBufferAdvance(toSend);
    }
```

- [ ] **Step 4: Add the `sheetsFallbackMaxSendPerTick` constant**

Find `const unsigned long sheetsFallbackInterval = 60000;` (search for it — it's declared near `lastSheetsFallbackPostTime`, well before `loop()`). Directly below it, add:

```cpp
const int sheetsFallbackMaxSendPerTick = 10; // bounds one flush tick to 10 sequential Apps Script POSTs -- trickle, not a burst
```

- [ ] **Step 5: Verify the edit's shape**

No compiler is available in this environment. Read back the edited region and confirm:
- `sheetsFallbackBufferPush(` is now called with 4 arguments (`temperatureC, turbidityADC, tdsVoltage, (float)flowPulses`) — grep the whole file for `sheetsFallbackBufferPush(` and confirm there is exactly one call site and it matches.
- `sheetsFallbackBufferClear()` no longer appears anywhere inside the `if (backendKnown) { ... }` success branch — grep the whole file for `sheetsFallbackBufferClear(` and confirm it now has ZERO call sites in `loop()` (the function itself still exists from Task 1, just unused for now — that's expected; it exists for e.g. a future `WIFI_CLEAR`-style reset command to call, not required by this feature).
- `sheetsFallbackBufferAdvance(toSend)` appears exactly once, at the end of the flush block.
- `nominalFlowRate(` is called exactly once, inside the flush block's JSON-building.

If you have Arduino IDE / `arduino-cli` available in your environment, compile the sketch and confirm it builds with no errors — report the result either way.

- [ ] **Step 6: Manual verification (requires physical hardware — do as much as you can, note what's unconfirmed)**

If you have the actual ESP32 board and can flash it:
1. Flash the updated sketch.
2. Disconnect the board's WiFi (or `WIFI_SET` it to a wrong/unreachable SSID) for at least 2-3 minutes while watching the Serial Monitor's existing per-reading debug output (`Flow pulses=...` etc. already print every `broadcastInterval` tick).
3. Reconnect WiFi. Confirm the Serial Monitor prints `Sheets fallback flush: N/M sent this tick, R remaining` roughly once every `sheetsFallbackInterval` (60s), with `N` capped at 10 and `R` decreasing tick over tick until it reaches 0.
4. Check the deployed Google Sheet (the one `sheetsWebhookUrl` points at) for new rows covering the outage window, including non-blank Flow Rate values.
5. If a backend PC is also available: start it mid-drain (after step 3 has begun but before the backlog reaches 0) and confirm the Serial Monitor's flush-progress lines continue on subsequent ticks rather than stopping — this is the "backend recovery no longer clears the buffer" behavior from Task 2 Step 2.

If you do NOT have physical hardware access in this environment, skip this step and report that it's unconfirmed — do not fabricate results. The code-level checks in Step 5 are the available verification.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/Ace/Documents/projects/WaterQualityChecker"
git add firmware/esp32/esp32.ino
git commit -m "Buffer readings during WiFi outages too, trickle-drain recovery, decouple from backend recovery"
```

---

## Self-review notes

- **Spec coverage**: buffer size/shape + flow field (Task 1), trigger condition widened to cover WiFi-down (Task 2 Step 3), trickle flush capped at 10/tick (Task 2 Steps 3-4), early-clear-on-backend-recovery removed (Task 2 Step 2), `flowRate` field matching `google_apps_script.gs`'s `doPost` contract via `nominalFlowRate` (Task 1 Step 3, used in Task 2 Step 3). All spec sections covered.
- **No test framework**: acknowledged explicitly in Global Constraints and each task's verification steps — this is not an oversight, this repo genuinely has none for firmware.
- **Type consistency checked**: `sheetsFallbackBufferPush`'s signature (4 floats) matches its one call site in Task 2. `sheetsFallbackBufferAdvance(int n)` defined in Task 1, called with `toSend` (an `int`) in Task 2 — matches. `nominalFlowRate(float pulses, float intervalSeconds)` defined in Task 1, called with `(sheetsFallbackFlowBuffer[idx], broadcastInterval / 1000.0)` in Task 2 — `sheetsFallbackFlowBuffer[idx]` is a `float` (matches `pulses`), `broadcastInterval / 1000.0` is a `double` literal division that implicitly narrows to `float` for the parameter (matches existing patterns elsewhere in this file, e.g. `dividerRecoveryFactor` usage).
