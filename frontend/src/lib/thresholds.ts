/**
 * Single source of truth for reference-line values and status bands used across
 * every chart, sparkline, and gauge — a hard requirement, on every chart/sparkline/gauge.
 *
 * Units:
 * - turbidity: NTU (Nephelometric Turbidity Units)
 * - tds: ppm (parts per million)
 * - ec: µS/cm (microsiemens per centimeter)
 * - temperature: °C
 * - wqi: unitless score 0-100
 *
 * NOTE on TEMPERATURE_THRESHOLDS.min/max: these are retained ONLY for back-compat
 * with existing single-sided consumers (e.g. wqi.ts's symmetric falloff calc,
 * chart reference lines). The authoritative two-sided band data now lives in
 * RANGE_BANDS below, whose temperature good band (25-30 °C) intentionally
 * differs from this legacy min/max (20-32 °C) — that change is approved.
 */

export type Status = 'good' | 'warn' | 'danger'

export const STATUS_COLOR: Record<Status, string> = {
  good: '#22c55e', // green-500
  warn: '#facc15', // yellow-400 -- brighter/more saturated than the old amber-500 for visibility
  danger: '#ef4444', // red-500
}

/** Turbidity: clear water is low NTU; above the warn line, danger doubles it. */
export const TURBIDITY_THRESHOLDS = {
  unit: 'NTU',
  warn: 25,
  danger: 50,
} as const

/** TDS: WHO/EPA-style palatability bands, in ppm. */
export const TDS_THRESHOLDS = {
  unit: 'ppm',
  warn: 300,
  danger: 500,
} as const

/** EC: derived from TDS (~2x), same shape as TDS thresholds in µS/cm. */
export const EC_THRESHOLDS = {
  unit: 'µS/cm',
  warn: 600,
  danger: 1000,
} as const

/** Temperature: advisory band for reservoir/freshwater aquatic health, in °C. */
export const TEMPERATURE_THRESHOLDS = {
  unit: '°C',
  min: 20,
  max: 32,
} as const

/** WQI: 0-100 score bands. */
export const WQI_THRESHOLDS = {
  unit: 'score',
  moderate: 50,
  good: 70,
} as const

export type ThresholdParam = 'turbidity' | 'tds' | 'ec' | 'temperature' | 'wqi'

/**
 * Compute the status band for a given parameter's value.
 * For the 4 sensor params this simply delegates to `rangeStatusFor` (two-sided bands).
 * For `wqi`, higher is better ('good' >= good threshold, 'warn' >= moderate, else 'danger').
 */
export function statusFor(param: ThresholdParam, value: number): Status {
  switch (param) {
    case 'turbidity':
    case 'tds':
    case 'ec':
    case 'temperature':
      return rangeStatusFor(param, value).status
    case 'wqi':
      if (value >= WQI_THRESHOLDS.good) return 'good'
      if (value >= WQI_THRESHOLDS.moderate) return 'warn'
      return 'danger'
    default:
      return 'good'
  }
}

/** Convenience: status -> color, one hop from a raw value. */
export function colorFor(param: ThresholdParam, value: number): string {
  return STATUS_COLOR[statusFor(param, value)]
}

// ---------------------------------------------------------------------------
// Two-sided range bands (WHO/EPA-informed), direction-aware evaluator.
// ---------------------------------------------------------------------------

export type RangeParam = 'temperature' | 'turbidity' | 'tds' | 'ec'

export interface RangeBand {
  unit: string
  /** Lower bound of the "good" band. Omitted for upper-only params (turbidity). */
  goodMin?: number
  /** Upper bound of the "good" band. */
  goodMax?: number
  /** At/below this on the low side -> 'danger'. Between this and goodMin -> 'warn'. */
  dangerMin?: number
  /** At/above this on the high side -> 'danger'. Between goodMax and this -> 'warn'. */
  dangerMax?: number
  /**
   * An implausibly low reading (at/near zero) usually indicates a disconnected/faulty sensor
   * rather than a genuine reading -- see `isSensorFault`. Set per-param below.
   */
  sensorFaultBelow?: number
}

/**
 * Approved two-sided bands:
 *
 * | Param       | Good        | Caution              | Danger            |
 * |-------------|-------------|----------------------|-------------------|
 * | Temperature | 25-30 °C    | outside 25-30         | < 20 or > 32      |
 * | TDS         | 100-300 ppm | 300-500 / 50-100      | < 50 or > 500     |
 * | EC          | 200-600     | 600-1000 / 100-200    | < 100 or > 1000   |
 * | Turbidity   | <= 25 NTU   | > 25                   | > 50              |
 */
export const RANGE_BANDS: Record<RangeParam, RangeBand> = {
  // sensorFaultBelow: 0.01 -- `main.py` forces temperatureC to 0.0 when the DS18B20 reports
  // DEVICE_DISCONNECTED_C, and a disconnected/unplugged TDS probe reads ~0.0V -> 0.0 ppm (EC
  // is derived from TDS, so it inherits the same failure mode). A genuine reading from any of
  // these three sensors in this reservoir deployment is never this close to exactly zero, so
  // this reuses isSensorFault below with a low false-positive risk.
  temperature: { unit: '°C', goodMin: 25, goodMax: 30, dangerMin: 20, dangerMax: 32, sensorFaultBelow: 0.01 },
  tds: { unit: 'ppm', goodMin: 100, goodMax: 300, dangerMin: 50, dangerMax: 500, sensorFaultBelow: 0.01 },
  ec: { unit: 'µS/cm', goodMin: 200, goodMax: 600, dangerMin: 100, dangerMax: 1000, sensorFaultBelow: 0.01 },
  // Turbidity is upper-only: no low band (a low NTU is good), and a value below
  // `sensorFaultBelow` is flagged as a likely sensor fault rather than a water problem.
  turbidity: { unit: 'NTU', goodMax: 25, dangerMax: 50, sensorFaultBelow: 0.2 },
}

export interface RangeStatus {
  status: Status
  /** Which side of the good band the value falls on. 'ok' whenever status is 'good'. */
  direction: 'high' | 'low' | 'ok'
}

/** Direction-aware status evaluator using the two-sided RANGE_BANDS. */
export function rangeStatusFor(param: RangeParam, value: number): RangeStatus {
  const band = RANGE_BANDS[param]

  if (band.goodMin != null && value < band.goodMin) {
    const status: Status = band.dangerMin != null && value <= band.dangerMin ? 'danger' : 'warn'
    return { status, direction: 'low' }
  }

  if (band.goodMax != null && value > band.goodMax) {
    const status: Status = band.dangerMax != null && value >= band.dangerMax ? 'danger' : 'warn'
    return { status, direction: 'high' }
  }

  return { status: 'good', direction: 'ok' }
}

/** Language-neutral normal-range text, e.g. "25–30 °C" / "≤ 25 NTU". Drop into detail.normalRange. */
export function normalRangeText(param: RangeParam): string {
  const band = RANGE_BANDS[param]
  if (band.goodMin != null && band.goodMax != null) {
    return `${band.goodMin}–${band.goodMax} ${band.unit}`
  }
  if (band.goodMax != null) {
    return `≤ ${band.goodMax} ${band.unit}`
  }
  if (band.goodMin != null) {
    return `≥ ${band.goodMin} ${band.unit}`
  }
  return band.unit
}

/** True when a param's reading is implausibly below its `sensorFaultBelow` band value (likely a sensor fault, e.g. a disconnected probe reading ~0). */
export function isSensorFault(param: RangeParam, value: number): boolean {
  const band = RANGE_BANDS[param]
  return band.sensorFaultBelow != null && value < band.sensorFaultBelow
}
