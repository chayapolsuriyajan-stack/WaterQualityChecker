/**
 * Single source of truth for reference-line values and status bands used across
 * every chart, sparkline, and gauge (per AQUA_MONITOR_PLAN.md — "hard requirement,
 * on every chart/sparkline/gauge").
 *
 * Units:
 * - turbidity: NTU (Nephelometric Turbidity Units)
 * - tds: ppm (parts per million)
 * - ec: µS/cm (microsiemens per centimeter)
 * - temperature: °C
 * - wqi: unitless score 0-100
 */

export type Status = 'good' | 'warn' | 'danger'

export const STATUS_COLOR: Record<Status, string> = {
  good: '#22c55e', // green-500
  warn: '#f59e0b', // amber-500
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
 * For `temperature`, "good" is inside [min,max]; outside is "warn" (single band,
 * since temperature has no separate danger tier defined by the plan).
 * For `wqi`, higher is better ('good' >= good threshold, 'warn' >= moderate, else 'danger').
 */
export function statusFor(param: ThresholdParam, value: number): Status {
  switch (param) {
    case 'turbidity':
      if (value >= TURBIDITY_THRESHOLDS.danger) return 'danger'
      if (value >= TURBIDITY_THRESHOLDS.warn) return 'warn'
      return 'good'
    case 'tds':
      if (value >= TDS_THRESHOLDS.danger) return 'danger'
      if (value >= TDS_THRESHOLDS.warn) return 'warn'
      return 'good'
    case 'ec':
      if (value >= EC_THRESHOLDS.danger) return 'danger'
      if (value >= EC_THRESHOLDS.warn) return 'warn'
      return 'good'
    case 'temperature':
      return value >= TEMPERATURE_THRESHOLDS.min && value <= TEMPERATURE_THRESHOLDS.max
        ? 'good'
        : 'warn'
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
