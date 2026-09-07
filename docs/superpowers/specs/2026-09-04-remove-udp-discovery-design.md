# Remove UDP discovery from firmware — design spec

Date: 2026-09-04
Status: approved, ready for planning
Branch: `feature/vercel-migration`

## Context

This is sub-project #1 of a larger, deliberately-decomposed effort to migrate the HydroMonitor
backend toward a Vercel-hosted deployment. The full effort (hosted DB migration, per-station
state migration, WebSocket replacement, `main.py` restructuring for Vercel's Python function
conventions, frontend adjustments) is out of scope here and will be brainstormed as its own
sub-projects (#2-6) once this piece lands. This sub-project only removes the firmware's UDP
same-LAN discovery path, since a Vercel-hosted backend can never be found via same-subnet UDP
broadcast anyway (it isn't on the board's LAN, and even if `main.py` itself eventually moves to
Vercel, that platform can't run a persistent UDP listener regardless).

`main.py`'s own UDP listener (`DiscoveryProtocol`, port 8888) is explicitly **not** touched by
this sub-project — it stays on `main`'s LAN-deployment path and will only become dead weight
once a later sub-project (#5) restructures `main.py` itself for Vercel.

## Decision: addressing mechanism

The board already has a fixed-backend-host override built for exactly this scenario —
`BACKEND_SET|<host>|<apiKey>|<https:0|1>` over USB (or the dashboard's WiFi panel), persisted to
NVS, applied via `applyBackendHost()`. This sub-project leans on that existing mechanism rather
than hardcoding a URL into the sketch, so the backend address (which will very likely change as
sub-projects #2-6 land — Vercel's Python function routing may end up under a different path than
today's flat `/update`) never requires a reflash to update.

The currently-uncommitted hardcoded `backendUrl = "https://water-quality-checker-five.vercel.app/update"`
(sitting in the working tree before this spec was written) is discarded in favor of this —
configuring the same address via `BACKEND_SET` once achieves the same result without baking a
URL into source.

## Changes (firmware/esp32/esp32.ino only)

1. **Delete `discoverBackend()` entirely**, along with the declarations it alone depends on:
   `discoveryPort`, `discoveryRequest`, `discoveryReply`, `discoveryUdp`, and the
   `#include <WiFiUdp.h>` line (confirmed nothing else in the sketch uses `WiFiUDP`).

2. **`setup()`**: replace the branch that spends up to 20s broadcasting for a backend when no
   fixed host is set with an unconditional `applyBackendHost()` call. `applyBackendHost()`
   already handles "no host configured" gracefully (`backendKnown = false`, no attempt made) —
   this sub-project adds a one-time log line telling the operator to use `BACKEND_SET` when
   that's the case, so "why isn't it posting" is diagnosable from the Serial Monitor alone.

3. **`loop()`'s backend-recovery block**: remove the `else if (discoverBackend())` /
   `else { Serial.println("Still searching for backend...") }` branches. With no fixed host,
   there's nothing to retry each tick — sensor reads and the Sheets fallback keep working
   regardless (unchanged, matches the sketch's existing "no backend needed" posture already
   documented for the Sheets-fallback feature).

4. **Fix the stale comment** at the `WIFI_SET` success handler (`backendKnown = false; // force
   UDP rediscovery...`) — rewritten to reflect that it now just forces `applyBackendHost()` to
   re-run on the next tick (relevant if a fixed host is set and the board just moved to a
   different WiFi network), not a UDP broadcast that no longer exists.

## Non-goals

- No changes to `main.py`.
- No changes to the frontend.
- No changes to `google_apps_script.gs`.
- Does not address anything from sub-projects #2-6 (hosted DB, per-station state migration,
  WebSocket replacement, Vercel function restructuring, frontend API base URL).

## Testing

No automated test suite exists for this file (Arduino sketch). Verification is manual:
read-back confirmation that every discovery symbol is gone (`grep` for `discoverBackend`,
`discoveryUdp`, etc. returns nothing), and, if hardware is available, flashing the board with
no `BACKEND_SET` configured and confirming the Serial Monitor shows the new "use BACKEND_SET"
message instead of a 20s discovery attempt, then confirming `BACKEND_SET` still works exactly
as before.
