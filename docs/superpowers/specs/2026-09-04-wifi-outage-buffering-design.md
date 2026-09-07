# WiFi-outage offline data buffering — design spec

Date: 2026-09-04
Status: approved, ready for planning

## Purpose

The ESP32 firmware already has a "Sheets fallback" buffer (`firmware/esp32/esp32.ino`) that
captures readings when the backend PC specifically is unreachable, so a backend outage doesn't
silently drop data. But its push condition (`(!backendKnown || backendPostFailed) &&
WiFi.status() == WL_CONNECTED`) requires WiFi to be up — during an actual WiFi outage (the
board's own network connection down, not just the backend PC), nothing is buffered at all, and
readings taken during that window are lost permanently. This closes that gap: readings taken
during a genuine WiFi outage are captured and, once connectivity returns, drained to the same
Google Sheets destination the existing fallback already uses.

## Scope decisions from brainstorming

- **RAM-only, no reset survival.** A board reset/power-loss during the outage window loses
  whatever's buffered so far. Explicitly accepted — flash-backed persistence (LittleFS/SPIFFS)
  was considered and rejected as unnecessary complexity for this iteration.
- **~1 hour capacity** (1800 readings at the existing 2s `broadcastInterval` cadence).
- **Flow pulses are now included** in the buffered payload (previously omitted from the
  Sheets-fallback path entirely, per `CLAUDE.md`'s Firmware section — "flowPulses is not
  included -- only temperature/turbidity/TDS").
- **Recovery is a trickle, not a burst.** A capped batch of buffered readings is sent per
  `sheetsFallbackInterval` tick (60s), not the whole backlog at once — bounds worst-case
  recovery time to a background drain rather than a multi-minute blocking burst that would
  delay live readings.
- **Buffer draining is now independent of backend recovery.** Today, the buffer is discarded
  the moment the *backend* becomes reachable again (`sheetsFallbackBufferClear()` on the first
  successful backend POST), even if the buffer hasn't finished flushing to Sheets yet — a
  backlog can be silently lost if backend recovery happens to land between flush ticks. This
  spec removes that early-clear: the two recovery paths (backend reachable again vs. buffer
  drained to Sheets) become independent, since backend's `/update` has no mechanism to accept
  historical/backfilled readings — only Sheets can receive the backlog at all.

## Architecture

All changes are confined to `firmware/esp32/esp32.ino`. No backend (`main.py`) or frontend
changes — buffered readings arrive at the same Google Apps Script `doPost` endpoint, in the
same per-reading JSON shape the existing Sheets fallback already sends, just with a `flow`
field added (see Data shape below) and via a different trigger/drain schedule.

### 1. Buffer sizing and shape

Replace the existing `sheetsFallbackBufferSize = 30` arrays with:

```cpp
const int sheetsFallbackBufferSize = 1800; // ~1 hour at the 2s broadcastInterval cadence
float sheetsFallbackTempBuffer[sheetsFallbackBufferSize];
float sheetsFallbackTurbBuffer[sheetsFallbackBufferSize];
float sheetsFallbackTdsVoltageBuffer[sheetsFallbackBufferSize];
float sheetsFallbackFlowBuffer[sheetsFallbackBufferSize]; // NEW: raw flowPulses count for that reading
```

`sheetsFallbackBufferPush(...)` gains a `flowPulses` parameter and writes it into the new
array alongside the existing three. `sheetsFallbackBufferClear()` is unchanged in shape (just
resets the count/next-index bookkeeping, which already works identically regardless of array
size).

**Memory**: 1800 × 4 floats × 4 bytes = ~28.8KB. Comfortably within the ESP32's available RAM
alongside the WiFi stack and everything else already running.

### 2. Trigger condition — capture during a genuine WiFi outage, not just backend-down

Current condition (in `loop()`, guarding both the push and the flush):
```cpp
if ((!backendKnown || backendPostFailed) && WiFi.status() == WL_CONNECTED) {
```

This conflates two different things: *whether to push a new reading into the buffer* (should
happen whenever the live backend POST didn't succeed, WiFi up or not) and *whether to attempt a
Sheets flush this tick* (can only happen with WiFi actually up, regardless of backend state).
Split them:

```cpp
bool liveDeliveryFailed = !backendKnown || backendPostFailed; // backend POST didn't succeed this tick (covers "never discovered" and "just failed", including because WiFi itself was down -- backendPostFailed only becomes true inside the WiFi-connected branch today, so also treat "WiFi down entirely" as a delivery failure)
if (WiFi.status() != WL_CONNECTED) liveDeliveryFailed = true;

if (liveDeliveryFailed) {
  sheetsFallbackBufferPush(temperatureC, turbidityADC, tdsVoltage, flowPulses);
}

if (WiFi.status() == WL_CONNECTED && currentMillis - lastSheetsFallbackPostTime >= sheetsFallbackInterval && sheetsFallbackBufferCount > 0) {
  // ... trickle flush, see below ...
}
```

Push happens unconditionally on any delivery failure (WiFi down, backend down, or POST
failure); flush is attempted independently, gated only on WiFi being up and the interval timer,
regardless of whether the push condition is *currently* true (so a backlog keeps draining even
after backend has recovered and new readings are flowing normally again).

### 3. Trickle flush — bounded batch per tick, not the whole buffer

Add a cap constant:
```cpp
const int sheetsFallbackMaxSendPerTick = 10; // bounds one flush tick to ~10 sequential Apps Script POSTs
```

Replace the existing `for (int i = 0; i < sheetsFallbackBufferCount; i++)` full-drain loop with
one that sends at most `sheetsFallbackMaxSendPerTick` entries starting from the oldest, and only
removes the entries that were actually attempted this tick from the buffer (advances the
"oldest" tracking and decrements the count by the number processed, matching entries which
failed to send are still dropped after one attempt — same fire-and-forget posture as today,
not a retry queue). Any remaining entries stay buffered for the next tick, 60s later, so a
1800-entry backlog fully drains over roughly 1800 / 10 × 60s ≈ 3 hours in the background.

The existing oldest-index math (`oldestIdx = (sheetsFallbackBufferCount < sheetsFallbackBufferSize) ? 0 : sheetsFallbackBufferNext`)
still applies to find the start of the batch; after sending up to `sheetsFallbackMaxSendPerTick`
entries, the buffer's logical "count" shrinks by however many were processed (not reset to
zero), and the "oldest" pointer advances by the same amount — a partial drain, not a full clear.

**Resolved from `google_apps_script.gs`**: `doPost` expects `data.flowRate` — an instantaneous
L/min value (the sheet's "Flow Rate (L/min)" column), not a raw pulse count. Raw pulses alone
aren't meaningful there. Following the exact precedent already set by this same fallback path's
TDS handling (`dfrobotUncalibratedPpm` — the real k-factor lives in `calibration.json` on the
backend, unreachable from the firmware, so the fallback path computes an uncalibrated value
using the nominal default instead of omitting it), add a firmware-side helper using the nominal
YF-S201 k-factor (450 pulses/liter, the same default `main.py`'s `_default_calibration()` uses
before any personal calibration exists):

```cpp
// Uncalibrated flow rate (L/min) for the Sheets fallback path only -- mirrors
// dfrobotUncalibratedPpm's reasoning for TDS: the real k-factor lives in calibration.json on
// the backend PC, unreachable from here, so this uses the nominal YF-S201 default (450
// pulses/liter, matching main.py's _default_calibration()) rather than omitting flow entirely.
float nominalFlowRate(float pulses, float intervalSeconds) {
  float liters = pulses / 450.0;
  return liters / (intervalSeconds / 60.0);
}
```

Buffered flush computes `nominalFlowRate(sheetsFallbackFlowBuffer[idx], broadcastInterval / 1000.0)`
(the buffer stores raw pulses per `broadcastInterval` tick, so `intervalSeconds` is
`broadcastInterval / 1000.0`, i.e. 2.0 for the current 2000ms default) and sends the result
under the `flowRate` key, matching the live path's key exactly.

### 4. Remove the early-clear-on-backend-recovery

Delete this block from the successful-backend-POST branch:
```cpp
// The backend has caught up to the present again -- readings buffered for the
// Sheets fallback while it was down have served their purpose (or will on the next
// flush window); clear so a late-arriving flush doesn't resend now-stale readings.
sheetsFallbackBufferClear();
```

Backend recovery no longer touches the buffer at all. The buffer only shrinks via the trickle
flush actually sending entries (point 3). This is the intentional behavior change from
brainstorming: a backlog captured during a WiFi outage is guaranteed to keep draining to Sheets
regardless of what the backend is doing, since the backend has no mechanism to receive
backfilled historical readings.

## Data flow summary

```
Every broadcastInterval (2s) tick in loop():
  read sensors -> attempt live backend POST (if backendKnown)
       |
       +-- POST succeeds -> consecutiveFailures = 0 (buffer untouched -- no more early-clear)
       |
       +-- POST fails, OR backend not yet known, OR WiFi.status() != WL_CONNECTED
                -> sheetsFallbackBufferPush(temp, turbidity, tdsVoltage, flowPulses)
                   (buffer grows, capped at 1800, oldest silently overwritten once full)

  Independently, every sheetsFallbackInterval (60s) tick, IF WiFi is up and buffer non-empty:
    -> send up to sheetsFallbackMaxSendPerTick (10) oldest buffered readings to
       Google Apps Script doPost, one HTTP POST each
    -> remove only the entries actually sent from the buffer (partial drain)
    -> repeat next tick until buffer empty
```

## Testing

No automated test suite exists for the firmware (Arduino sketch, no test framework in this
repo). Verification is manual, via the Serial Monitor and the deployed Google Sheet:

- Disconnect the board's WiFi (or point it at a wrong SSID via `WIFI_SET`) for several minutes
  while readings continue on the Serial Monitor's plain debug output, confirm the buffer's
  fill count grows (add a `Serial.printf` of `sheetsFallbackBufferCount` if not already
  present, or rely on existing debug output).
- Reconnect WiFi, confirm the Serial Monitor shows repeated "Sheets fallback flush: N/M sent"
  lines roughly once a minute, each sending at most 10, until the backlog reaches 0.
- Confirm the buffered readings actually land in the Google Sheet (check the deployed Apps
  Script's target spreadsheet for the expected row count/timestamps covering the outage
  window).
- Confirm a live backend recovery *during* an active drain does not clear the remaining
  backlog (reconnect the backend PC mid-drain, confirm the Serial Monitor keeps showing flush
  progress on subsequent ticks rather than stopping).

## Open questions for the implementation plan

None — the flow-field question was resolved directly against `google_apps_script.gs` during
this spec's writing (see the `nominalFlowRate` helper above).
