---
name: sensor-calibration
description: Calibrate or verify the HydroMonitor turbidity (NTU) and TDS sensor conversions. Use when raw ADC/voltage readings don't match known water samples, when capturing new reference points via the /calibrate page, when adjusting the turbidity 2-point map or TDS k-factor, or when checking TDS temperature compensation.
disable-model-invocation: true
---

# Sensor Calibration (HydroMonitor)

Calibration is **backend-owned** (as of the calibration-mode work): the ESP32
streams raw values, and `main.py` converts them using coefficients in
`calibration.json`. You recalibrate **live from the `/calibrate` web page — no
reflash**. This skill holds the durable sensor math plus the runtime workflow.

## Durable domain knowledge (survives refactors)

### Hardware context (must hold true before trusting any number)

| Sensor | ADC pin | Path | Supply |
|---|---|---|---|
| Turbidity | GPIO34 (ADC1) | 5V sensor OUT → **voltage divider** → ADC | true 5V rail |
| TDS Meter V1.0 | GPIO35 (ADC1) | direct, **no divider** (~2.3V max) | 3.3V |
| DS18B20 temp | GPIO13 | OneWire digital, 4.7kΩ pull-up to 3.3V | 3.3V |

ESP32 GPIOs are **3.3V max** (not 5V tolerant). ADC2 pins are unusable while
Wi-Fi is on — both analog sensors must stay on ADC1. ESP32 ADC is non-linear
near its extremes (below ~0.1V and above ~3.1V); calibrate in the mid-range and
distrust readings at the rails.

### Turbidity → NTU (backend: 2-point linear)

The firmware sends the averaged **raw ADC** (higher ADC = clearer water). The
backend maps it linearly: `NTU = slope·ADC + intercept`, with
`slope = (ref2−ref1)/(raw2−raw1)` (negative) and `intercept = ref1 − slope·raw1`.
Two captured points define the line; clean water (0 NTU) is the natural first
anchor. (A DFRobot voltage-polynomial `NTU = −1120.4·V² + 5742.3·V − 4353.8`
exists for 5V-powered sensors, but it was unstable through this board's divider,
so the project uses the empirical 2-point ADC map instead.)

### TDS → ppm (backend: DFRobot formula × k-factor)

The firmware sends the raw **tdsVoltage**. The backend applies DFRobot's official
temperature-compensated formula (reusing the live DS18B20 `temperatureC`, **not**
a fixed 25°C) then scales by a single k-factor:

```
compensationCoefficient = 1.0 + 0.02 * (temperatureC - 25.0)
V   = tdsVoltage / compensationCoefficient
ppm = k * (133.42*V³ - 255.86*V² + 857.39*V) * 0.5
```

`k` is fitted from one known-ppm solution: `k = referencePpm / dfrobotPpm` at the
captured voltage/temp. The `0.5` factor is DFRobot's ppm conversion — leave it.

## Runtime workflow (how to apply — thin, swappable mechanics)

1. Run the backend (`python main.py`) and open **`/calibrate`**. Confirm the feed
   shows "live readings" (the ESP32 must be POSTing, or simulate — see below).
2. **Turbidity (needs 2 points):** dip in clean water, enter `0` NTU, Capture.
   Then a turbid standard (or a factory meter's reading), enter its NTU, Capture.
   The page shows the computed slope/intercept and a live NTU preview.
3. **TDS (needs 1 point):** dip in a known-ppm solution (e.g. 707 ppm / 1413
   µS·cm⁻¹) at a measured water temp, enter the ppm, Capture. Verify the live
   ppm now matches.
4. **Save** — persists to `calibration.json` and applies to the live `/update`
   stream immediately. **Reset** clears a sensor back to defaults.

Captures average the last ~5 raw readings to damp noise. Nothing takes effect
until Save; captured points can be deleted before saving.

### Simulating without hardware
POST raw payloads to exercise the whole path:
`curl -X POST localhost:8080/update -H "Content-Type: application/json" -d '{"temperature":25,"turbidity":1500,"tdsVoltage":1.41}'`
Then capture on `/calibrate` as usual. On Windows, run the backend with
`PYTHONUTF8=1` (the startup prints use emoji and crash under cp1252 otherwise).

## Verification checklist (run every recalibration)

1. Confirm wiring/supply matches the table above (5V truly 5V; divider on
   turbidity only).
2. Clean/reference water → turbidity ≈ 0 NTU, TDS ≈ the solution's rated ppm.
3. Sweep ≥2–3 known points; record predicted vs. actual (the page's live preview
   makes this immediate).
4. Consistent offset → recheck anchors (turbidity) or temperature compensation
   (TDS). Nonlinear error across the range → the 2-point line is too coarse;
   capture points nearer your operating range.
5. Contract check: firmware and backend are **not** auto-synced. The `/update`
   payload keys (`temperature`, `turbidity`, `tdsVoltage`) must match between
   `esp32.ino` and `main.py`. (Legacy boards sending `tds` ppm still pass
   through, but can't be TDS-calibrated until they send `tdsVoltage`.)

## Common failure modes

- **`turbidityNtu` stays null** → fewer than 2 turbidity points captured/saved.
- **NTU absurd or negative-clamped everywhere** → the 2 anchors are too close in
  ADC (tiny denominator → wild slope), or captured at the ADC's non-linear rails.
- **TDS drifts with water temperature** → `temperatureC` stale/−127 (DS18B20 read
  failure) feeding the compensation coefficient.
- **No "live readings" on `/calibrate`** → the ESP32 isn't POSTing (or simulate
  with the curl above); `latestRaw` stays null so Capture 409s.
