# Quick View summary card + connection-aware tab title + sensor-fault detection

**Date:** 2026-08-14 · **Status:** Approved (brainstorming) · **Repo:** WaterQualityChecker

## Context

The Dashboard tab's right column (`frontend/src/components/shell/RightContextColumn.tsx`) currently shows one card: station identity/GPS, then a connectivity row (online/offline + `Radio` pulse) and a live clock. There's no at-a-glance summary of the actual sensor readings anywhere outside the main 2×2 param grid, and the browser tab title is always the static "Aqua Monitor" regardless of connection state. Live testing surfaced TDS/EC pinned at exactly `0.0` while the WS connection itself was healthy — the existing turbidity-only "sensor fault" concept (`isSensorFault` in `lib/thresholds.ts`) doesn't cover this.

## Goals

1. A compact "Quick View" card below the connectivity card, dashboard-tab-only, showing overall WQI and the 4 live param values at a glance.
2. The browser tab title reflects live WS connection state.
3. Per-parameter "sensor looks disconnected" detection, generalized from the existing turbidity-only fault check to all 4 params, surfaced in the Quick View card and reused in the two places that already render per-param status.

## Non-goals

- No new backend/API changes — everything here is a pure frontend view over data already flowing through `useSensorData()`.
- No historical/trend view in the Quick View card (that's the existing WQI chart's job).
- Tab title text does not follow the EN/ไทย language toggle (explicit decision — always English).
- Not changing the WQI scoring formula, thresholds, or the main ParamGrid's layout.

## Design

### 1. Quick View card

New component: `frontend/src/components/shell/QuickViewSummary.tsx`.

Rendered inside `RightContextColumn.tsx`, as a sibling `div` directly below the existing connectivity card (same `flex flex-col gap-4` wrapper), so it only appears where `RightContextColumn` already appears — the Dashboard tab (`view === 'dashboard'` in `App.tsx`), at all breakpoints that component already supports.

Content:
- **Header**: "Quick view" label (new i18n string, see below) + WQI badge — score number and a band-colored pill (`good`/`moderate`/`poor`/`unknown`), computed via the existing `wqiFromReading(reading)` from `lib/wqi.ts`. No new WQI logic.
- **4 rows**, one per `PARAM_ORDER` entry (temperature, turbidity, tds, ec):
  - Icon + label from `PARAM_META` (reused, not duplicated).
  - Current value, formatted with `PARAM_META[param].precision`, + unit. Turbidity uses the same NTU-vs-raw-ADC selection logic already in `ParamGrid.tsx` (`turbidityUnit === 'NTU'` → `turbidityNtu`, else raw `turbidity`, labeled ADC).
  - Status indicator: a small colored dot using `statusFor`/`colorFor` (same source of truth as `ParamCard`) — **unless** `isSensorFault` is true for that param, in which case the row shows a warning icon + muted "not connected" style label instead of the normal status dot (see §3).

No new data fetching or WS handling — purely a derived view of `reading` from `useSensorData()`, same as every other dashboard consumer.

### 2. Tab title reflects connection status

New component: `TabTitleSync` (returns `null`, no visual output), defined and mounted once in `App.tsx`, inside `<SensorProvider>` (needs `useSensorData()`).

```
function TabTitleSync() {
  const { connected } = useSensorData()
  useEffect(() => {
    document.title = connected ? 'Aqua Monitor — Connected' : 'Aqua Monitor — Offline'
  }, [connected])
  return null
}
```

Mounted directly inside the `<SensorProvider>` tree in `App.tsx`, alongside the existing shell — runs regardless of which tab (`view`) is active, since connection state is global. Always English (explicit decision). No new strings.ts keys needed for this piece.

### 3. Sensor-fault detection generalized to all 4 params

`lib/thresholds.ts`: extend `RANGE_BANDS` so `temperature`, `tds`, and `ec` each get a `sensorFaultBelow` value (currently only `turbidity` has one, `0.2`). Use a small epsilon — `0.01` — for the other three:

```
temperature: { ..., sensorFaultBelow: 0.01 },
tds:         { ..., sensorFaultBelow: 0.01 },
ec:          { ..., sensorFaultBelow: 0.01 },
```

Rationale: `main.py` forces `temperatureC = 0.0` when the DS18B20 reads `DEVICE_DISCONNECTED_C`, and TDS/EC computed from an unplugged/disconnected TDS probe read essentially `0.0` voltage → `0.0` ppm. A genuine reading from any of these three sensors is never that close to exactly zero in this deployment (reservoir water), so this is a low-false-positive way to reuse the existing `isSensorFault(param, value)` function completely unchanged — only the band data changes.

Three call sites, all reusing the one function (no new fault-detection logic elsewhere):
- **`RangeWarning.tsx`**: currently gates the fault check with `param === 'turbidity' &&` — remove that restriction so any param's fault shows the existing "check the sensor" copy when `direction === 'low' && isSensorFault(param, value)`.
- **`ParamGrid.tsx` / `ParamCard.tsx`**: extend the existing `hint` mechanism (today only used for turbidity's "uncalibrated" note) to also show a "check sensor" hint when `isSensorFault` is true for any param.
- **`QuickViewSummary.tsx`** (new, §1): each row checks `isSensorFault` for its param and swaps the normal status dot for a warning icon + "not connected"-style label when true.

## i18n

New keys in `frontend/src/lib/strings.ts` (both `en` and `th`, matching the existing `satisfies` pattern):
- `quickview.title` — "Quick view" heading.
- `quickview.sensorFault` — short label for a faulting param row, e.g. "Not connected" (distinct from the existing "check sensor" copy used in the detail modal's `RangeWarning`, which is a full description — this is a compact row-level label).

All other text (param labels, status words, WQI band names) reuses existing keys — no duplication.

## Error handling / edge cases

- `reading === null` (no data ever received): Quick View card shows all rows as `—` with the existing "unknown" status styling, WQI badge shows "unknown" band — same pattern `ParamGrid` already uses for this state, not a new one.
- Uncalibrated turbidity (raw ADC, no NTU): shown as ADC with the existing "uncalibrated" hint, not treated as a sensor fault (these are orthogonal — uncalibrated just means no NTU conversion yet, it doesn't mean disconnected).
- A param can't be simultaneously "uncalibrated" and "faulting" in a way that conflicts visually: turbidity's hint priority is uncalibrated > fault > normal, since an uncalibrated sensor's raw ADC value is not comparable to the `sensorFaultBelow` NTU threshold at all (different units) — `isSensorFault` is only evaluated on the NTU value, so it naturally doesn't fire when uncalibrated.

## Testing / verification

- `npm run build` clean (TypeScript).
- Visual check on the Dashboard tab: Quick View card renders below the connectivity card, WQI badge and 4 rows show live values matching the main ParamGrid.
- Force a stale/disconnected state (stop the ESP32 or the backend) and confirm: tab title flips to "Aqua Monitor — Offline"; on reconnect with fresh data, flips back to "— Connected".
- With TDS/EC pinned at `0.0` (the real condition observed live), confirm the Quick View row, the main ParamGrid hint, and the detail modal's `RangeWarning` all now flag it as a likely sensor fault instead of silently showing "0 ppm" as if it were a real reading.
- Responsive check: Quick View card doesn't overflow at the existing `RightContextColumn` breakpoints (already responsive via its parent).
