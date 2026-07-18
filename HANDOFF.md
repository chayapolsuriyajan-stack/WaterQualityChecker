# Session Handoff — Sensor Calibration Mode + README

**Date:** 2026-07-18
**Repo:** WaterQualityChecker (HydroMonitor) · branch `master` · remote `origin` (GitHub)
**Purpose:** Continue this work on a second device. All the work below is **committed nowhere yet — it's uncommitted in the working tree**, so the first step to sync is commit + push (see "How to sync" at the bottom).

---

## What was done this session

1. **Backend-owned sensor calibration mode** (the main feature)
   - Firmware now streams *raw* values; the backend converts + owns calibration, so sensors are re-tuned live with **no reflash**.
   - Turbidity: 2-point linear ADC→NTU. TDS: DFRobot temp-compensated ppm × a single k-factor.
   - New standalone **`/calibrate`** web page to capture reference points, see coefficients, save/reset.
   - Persisted to `calibration.json` (git-ignored — it's per-device/per-sensor).
2. **Primary dashboard now shows real NTU** — the React SPA at `/` read `turbidity` and labeled it "NTU" but was getting raw ADC (showed absurd values like "1539 NTU"). Backend now puts calibrated NTU into `turbidity` (raw kept in `turbidityRaw`, unit in `turbidityUnit`); `/classic` dashboard updated to match.
3. **README rewritten** ([readme.md](readme.md)) — what it's for / how to use (with screenshots) / how it works. Screenshots in `docs/` (`dashboard.png`, `calibrate.png`), captured via Playwright against the running app.
4. **Windows UTF-8 startup fix** — `main.py` now forces UTF-8 on stdout/stderr, so `python main.py` no longer crashes on a cp1252 console (previously needed `PYTHONUTF8=1`).
5. **Docs/skill** — `CLAUDE.md` documents the new calibration system + changed firmware contract; the `sensor-calibration` skill was rewritten for the runtime workflow.

## Changed / new files
| File | Change |
|---|---|
| `main.py` | calibration state + `calibration.json` load/save, `apply_turbidity`/`apply_tds`, `/update` emits raw+calibrated fields (legacy-`tds` fallback), `/calibration*` REST API, `/calibrate` route, UTF-8 fix |
| `firmware/esp32/esp32.ino` | sends raw `tdsVoltage` instead of computing ppm on-device |
| `web/calibrate.html` | **new** standalone calibration page |
| `web/app.js` | `/classic` dashboard shows NTU/ADC per `turbidityUnit` |
| `webconfig.json` | `calibrationFile` key |
| `CLAUDE.md`, `readme.md` | docs |
| `.gitignore` | ignores `calibration.json` |
| `docs/` | **new** README screenshots |
| `.claude/skills/sensor-calibration/` | rewritten skill |
| `skill-observations/` | task-observer log (obs #1, #2) |

## Data contract (firmware ↔ backend) — keep in sync
- Firmware POSTs `{temperature, turbidity (raw ADC), tdsVoltage}` to `/update`.
- Backend broadcasts `{temperature, turbidity (=NTU when calibrated else ADC), turbidityRaw, turbidityNtu, turbidityUnit, tdsVoltage, tds (ppm), stats}`.
- Legacy boards that still POST `tds` (ppm) keep working (backend passes it through).

## Verification already done (all passed)
- Turbidity 2-pt fit exact (1500 ADC → 250 NTU), TDS k-factor makes a known solution read its rated ppm, save writes `calibration.json`, legacy `tds` passthrough, reset clears, UI capture works, UTF-8 startup no longer crashes.
- To re-verify on device 2: `pip install -r requirements.txt && python main.py`, then
  `curl -X POST localhost:8080/update -H "Content-Type: application/json" -d '{"temperature":25,"turbidity":1500,"tdsVoltage":1.41}'`
  and open `http://localhost:8080/calibrate`.

## Open items (nothing blocking)
- **Redundant nested clone `WaterQualityChecker/`** — a pristine duplicate git clone sitting inside the repo (clean, fully pushed, same commit). Safe to delete; the delete was blocked by Claude Code's auto-mode safety guard, so it needs a manual `rm -rf WaterQualityChecker` (PowerShell: `Remove-Item -Recurse -Force .\WaterQualityChecker`). **Do NOT `git add` this folder.**
- **TDS "abnormal" on the dashboard** is cosmetic — the SPA's normal range is 50–300 ppm; sample data sat ~368. Real readings decide the color.
- **Google Sheets** still logs raw ADC turbidity (column header says so); NTU columns would need an Apps Script schema change.
- `main.py` startup still uses the deprecated `@app.on_event("startup")` (FastAPI lifespan) — works, just a warning.

## Reference
- Approved implementation plan: `C:\Users\chaya\.claude\plans\i-wanna-create-a-reactive-conway.md` (local to device 1 — not in the repo).
- Full architecture / wiring / calibration math: [CLAUDE.md](CLAUDE.md).
- Calibration procedure + sensor math: `.claude/skills/sensor-calibration/SKILL.md`.

---

## How to sync to the other device

**On this device (push):**
```bash
# from the repo root; do NOT add the nested WaterQualityChecker/ folder
git add .gitignore CLAUDE.md readme.md HANDOFF.md main.py firmware web webconfig.json docs .claude skill-observations
git status                 # confirm the nested WaterQualityChecker/ is NOT staged
git commit -m "Add backend sensor calibration mode, /calibrate page, README + screenshots"
git push origin master
```

**On the other device (pull):**
```bash
git pull origin master
pip install -r requirements.txt      # deps unchanged, but safe
python main.py
```
Note: `calibration.json` is git-ignored, so each device keeps its **own** calibration (correct — calibration is per physical sensor). If you want the *same* calibration on both, copy `calibration.json` manually or re-capture on device 2 via `/calibrate`.
