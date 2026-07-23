---
name: firmware-contract-check
description: Use when editing main.py's update_sensor (/update handler) or firmware/esp32/esp32.ino's POST payload construction, before committing a change that touches the sensor JSON field names or shape sent between the ESP32 and the backend.
user-invocable: false
---

# Firmware/Backend Contract Check

## Overview
`main.py`'s `/update` endpoint and `firmware/esp32/esp32.ino`'s POST payload are not auto-synced (see CLAUDE.md). A field rename on one side silently breaks the other — the ESP32 has no schema validation, so a mismatch just drops data with no error visible anywhere.

## Current contract (verify against source before trusting this — it will drift)
Firmware (`esp32.ino`, `jsonDoc[...]` assignments near the `StaticJsonDocument` block) posts:
```json
{ "temperature": <float C>, "turbidity": <float raw ADC>, "tdsVoltage": <float V> }
```
Backend (`main.py`, `update_sensor`) requires `temperature` AND `turbidity` present, else it falls through to the form-encoded `water_level` branch. `tdsVoltage` is preferred; a legacy `tds` (pre-computed ppm) key is still accepted for un-reflashed boards.

## When to run this check
- A diff touches `main.py`'s `update_sensor` (or the `if "temperature" in data...` block)
- A diff touches `esp32.ino`'s `jsonDoc[...]` assignments

## Procedure
1. Grep `esp32.ino` for `jsonDoc["` — list every key it sets.
2. Grep `main.py`'s `update_sensor` for `data["`/`data.get(` — list every key it reads.
3. Diff the two lists. Every firmware-sent key must be read (or intentionally ignored) on the backend; every backend-required key must be sent by firmware, or covered by a documented legacy fallback (like `tds`).
4. If a key was renamed on only one side, flag it — don't silently "fix" the other side without confirming which name is correct. The backend can be redeployed instantly; the firmware needs physical reflash access.

## Common mistake
Renaming a JSON key on the backend to match Python naming conventions (e.g. `tdsVoltage` → `tds_voltage`). The firmware still sends `tdsVoltage`; the backend silently stops reading it and `tds`/`ec` vanish from every dashboard with no error logged anywhere.
