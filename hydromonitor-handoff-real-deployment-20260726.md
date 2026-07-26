# Handoff: HydroMonitor — moving to real deployment with real data

**Date:** 2026-07-26
**Repo:** `D:\projects\myprojects\WaterQualityChecker`
**Branch:** `feat/aqua-monitor-dashboard` (not merged to `main` — that's an open decision, not done)
**Latest commit:** `5a2b4f5` — "Wire ESP32 -> backend -> Sheets -> frontend end-to-end; promote app to /"

## Read these first — don't re-derive what they already say

- **`CLAUDE.md`** — architecture, sensor wiring table, calibration model, Google Sheets contract, firmware contract.
- **`AQUA_MONITOR_PLAN.md`** — full frontend design + Phase 1/2/3 build log + verification evidence for each phase.
- **`HANDOFF.md`** — prior session's handoff: build-complete status, known limitations, quick-start commands.
- **`firmware/esp32/esp32.ino`** — the physical firmware, source of truth for the wire contract.

This doc only covers what those don't: the gap between "wired and verified with synthetic/dev data" (true as of the last commit) and "genuinely running on real hardware with trustworthy data" (not yet true).

## What "real deployment with real data" needs, specifically

The pipeline code is wired and was verified end-to-end — but with **curl-simulated ESP32 payloads**, not a physical board, and against a Sheet that now has dev-test rows mixed into it. Concretely, before treating this as real:

1. **The live Google Sheet has test rows in it.** This session and the prior one POSTed many curl-simulated readings straight into the actual deployed spreadsheet to verify the pipeline (including deliberately implausible marker values like 99.9°C / 77.7°C, plus plausible-looking synthetic 24–28°C bursts). Before trusting sheet history as real: either clear/archive the sheet and start fresh, or record the cutover timestamp after which rows are genuine. Check the sheet directly rather than trusting `/history` alone.

2. **The Apps Script insert-at-top change isn't live yet.** `google_apps_script.gs` in this repo now writes new rows at row 2 (newest-first) instead of appending — but it's reference-only and does not auto-deploy. It must be pasted into the spreadsheet's **Extensions > Apps Script** editor and redeployed **as a new version**, or the live behavior stays on the old append-at-bottom model. (Harmless for `/history` either way — it's only about whether the sheet reads newest-first by eye.)

3. **`calibration.json`'s provenance is uncertain.** It's git-ignored/per-device and currently holds turbidity points labeled "clean water" / "450 NTU standard" and a TDS point labeled "707 ppm solution", all timestamped `2026-07-18` — from a session before this one. Whether these came from real reference solutions or bench-test guesses was not re-verified this session. Also: the TDS point list has an **exact duplicate entry** (harmless for the single-point k-factor model, but worth a look). Before trusting calibrated NTU/ppm output as real: recapture both sensors against known reference standards (app's Calibration tab, or the standalone `/calibrate` page) and confirm calibration mode is actually ON — `GET /calibration` → `"mode": true`.

4. **No process supervisor.** The backend has only ever been run ad hoc (`python main.py` in a foreground terminal, restarted manually many times this session). Real deployment needs it to survive a crash/reboot — nothing like Task Scheduler, `nssm`, a systemd unit, or Docker is set up. Needs a decision on deployment method for the target machine.

5. **Port conflict on this dev machine**: NVIDIA Broadcast binds `127.0.0.1:8080`, which wins over uvicorn's `0.0.0.0:8080` for any `localhost` request — every route silently 404s through `localhost` even though the server is healthy. Worked around during dev by hitting the LAN IP directly. For real deployment: either change the backend's port, stop/reconfigure NVIDIA Broadcast on the host, or make sure anyone accessing the dashboard uses the LAN IP/hostname, never `localhost`.

6. **UDP discovery firewall rule.** `CLAUDE.md` has the exact `netsh advfirewall` command for opening inbound UDP 8888. A fresh (or the real) deployment machine needs this added once, or `discoverBackend()` on the ESP32 times out silently forever.

7. **Firmware Wi-Fi credentials are hardcoded** in `firmware/esp32/esp32.ino` (not reproduced here — open the file). Confirm they match the actual deployment network before flashing or trusting connectivity.

8. **Has a real ESP32 ever POSTed to this backend?** Not established this session. Everything was verified via curl payloads shaped exactly like the firmware's JSON contract, never the physical board. If real hardware exists: confirm it's flashed with the *current* `esp32.ino` (sends raw `tdsVoltage`, not a legacy pre-computed `tds`), and can actually reach the backend on the real deployment network (UDP broadcast domain intact, no AP client-isolation, etc.).

## Recent architecture changes worth knowing before touching `main.py` or the frontend

This session promoted the dashboard from `/app` to `/` and **deleted** the two legacy dashboards it replaced (the black-box React SPA at `/`, the vanilla `/classic` dashboard) — not just unmounted, the files are gone. `/calibrate` (`web/calibrate.html`) is the only other surviving route. Any reference to `/app` or `/classic` you find outside historical/changelog prose in the docs is stale.

Also: `frontend/src/lib/useSensorSocket.ts` had its random-data "simulation fallback" removed this session. A real disconnect now freezes the last real reading and shows "Offline" — it no longer fabricates plausible-looking numbers. Don't reintroduce that pattern; for a monitoring system, synthetic noise during a real outage is worse than an honest gap.

## Known-unverified item from last session

The WebSocket reconnect-to-"Online" transition after a real gap wasn't independently confirmed live — the browser automation tool became unresponsive mid-check. The code path looks correct by inspection (`ws.onmessage` unconditionally sets `connected=true` on any message received), but it's worth a quick manual confirmation with an actual disconnect/reconnect cycle.

## Suggested skills for the next session

- **`verify`** — before claiming the real deployment works, drive it end-to-end rather than trusting code review or unit-style checks; this is exactly the kind of hardware+UI pipeline that skill exists for.
- **`systematic-debugging`** — if the real ESP32 doesn't show up (discovery timeout, wrong Wi-Fi, field-name mismatch), use this instead of guessing fixes.
- **`security-review`** — worth a deliberate pass before calling this "real": hardcoded Wi-Fi credentials in firmware, an Apps Script webhook URL that functions like a bearer credential, no auth on the calibration API. Not necessarily blocking, but should be a conscious call, not an oversight.
- **`grilling`** (if entering plan mode for deployment strategy) — the process-supervisor choice and the "clear the sheet or not" decision both deserve to be interrogated rather than assumed by default.
- **`finishing-a-development-branch`** — this work has lived on `feat/aqua-monitor-dashboard` for the entire session; once real-data deployment is confirmed working, that's the natural point to decide merge/PR/cleanup.

## Redacted / not reproduced here — check the files directly

- Google Sheets Apps Script webhook URL (`webconfig.json` → `googleSheetsWebhookUrl`): functions like a bearer credential granting write access to the spreadsheet.
- ESP32 Wi-Fi SSID/password (`firmware/esp32/esp32.ino`).
- Full `calibration.json` contents: mentioned above only as a provenance/quality flag, not to be copied elsewhere.
