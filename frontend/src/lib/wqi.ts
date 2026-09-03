/**
 * Frontend-derived Water Quality Index (WQI).
 *
 * Frontend-derived from live params — deliberately no backend WQI.
 * This is a simplified weighted sub-index model (not the full NSF-WQI with 9 parameters,
 * since we only have temperature/turbidity/tds/ec sensors — pH and DO are not yet installed).
 *
 * Weights (sum to 1.0):
 *   - turbidity:   0.35  (primary visual/health indicator we can measure well)
 *   - tds:         0.35  (dissolved solids — palatability + ecological stress)
 *   - ec:          0.10  (folded in with tds since ec is derived from tds; kept low weight
 *                         to avoid double-counting the same underlying measurement)
 *   - temperature: 0.20  (affects dissolved oxygen capacity and aquatic life stress)
 *
 * Each parameter maps to a 0-100 sub-index using `lib/thresholds.ts` bands:
 *   - 100 at "good", down to 50 at "warn" threshold, down to 0 at "danger" threshold
 *     (or beyond). Linear interpolation between anchor points.
 *   - Temperature has no "danger" band in thresholds.ts, so it uses a symmetric falloff
 *     around the [min,max] good band: 100 inside the band, decaying linearly to 0 at
 *     +/-10C past the nearest edge.
 *
 * Missing/unscorable parameters (e.g. turbidity before it's been calibrated to real NTU —
 * see below) are DROPPED from the calculation rather than scored as 0, and the remaining
 * weights are renormalized to still sum to 1 (each included weight divided by the sum of
 * included weights). If every parameter is missing, the result is 'unknown' with a null
 * score rather than a fabricated number.
 *
 * IMPORTANT: turbidity is only scored when it's a genuine NTU value (`turbidityNtu`, or a
 * raw `turbidity` field explicitly labeled NTU via `turbidityUnit`). The backend's
 * `calibration_mode` defaults OFF, in which case `turbidity` is a raw ADC value (~1000s)
 * that must never be run through the NTU thresholds — doing so caps the score permanently
 * low regardless of actual water quality.
 *
 * Final score = weighted average of sub-indices (using renormalized weights), rounded to
 * the nearest integer.
 * Bands: score >= 70 -> 'good', score >= 50 -> 'moderate', else 'poor'
 * (matches WQI_THRESHOLDS.good / WQI_THRESHOLDS.moderate in thresholds.ts).
 */
import {
  EC_THRESHOLDS,
  TDS_THRESHOLDS,
  TEMPERATURE_THRESHOLDS,
  TURBIDITY_THRESHOLDS,
  WQI_THRESHOLDS,
} from './thresholds'
import type { HistoryRow, SensorReading } from './types'

export type WqiParam = 'turbidity' | 'tds' | 'ec' | 'temperature'

const WEIGHTS: Record<WqiParam, number> = {
  turbidity: 0.35,
  tds: 0.35,
  ec: 0.1,
  temperature: 0.2,
}

const ALL_PARAMS = Object.keys(WEIGHTS) as WqiParam[]

export type WqiBand = 'good' | 'moderate' | 'poor' | 'unknown'

export interface WqiResult {
  /** Weighted score 0-100, or null if no parameter was scorable. */
  score: number | null
  band: WqiBand
  color: string
  /** Parameters that were unavailable/unscorable and excluded (with weight renormalized away). */
  excluded: WqiParam[]
}

const WQI_BAND_COLOR: Record<WqiBand, string> = {
  good: '#22c55e',
  moderate: '#f59e0b',
  poor: '#ef4444',
  unknown: '#9ca3af',
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Linear sub-index: 100 below `warn`, 50 at `warn`, 0 at/beyond `danger`. */
function subIndexLowerIsBetter(value: number, warn: number, danger: number): number {
  if (value <= warn) {
    // Interpolate 100 (at 0) down to 50 (at warn) — assumes 0 is the ideal floor.
    const t = clamp(value / warn, 0, 1)
    return 100 - t * 50
  }
  if (value >= danger) return 0
  const t = clamp((value - warn) / (danger - warn), 0, 1)
  return 50 - t * 50
}

function temperatureSubIndex(value: number): number {
  const { min, max } = TEMPERATURE_THRESHOLDS
  if (value >= min && value <= max) return 100
  const distance = value < min ? min - value : value - max
  const t = clamp(distance / 10, 0, 1)
  return 100 - t * 100
}

interface WqiInputs {
  temperature: number | null
  /** Must already be a genuine NTU value (or null if no calibrated NTU is available). */
  turbidity: number | null
  tds: number | null
  ec: number | null
}

function computeWqi(inputs: WqiInputs): WqiResult {
  const subIndices: Partial<Record<WqiParam, number>> = {}

  if (inputs.turbidity != null) {
    subIndices.turbidity = subIndexLowerIsBetter(
      inputs.turbidity,
      TURBIDITY_THRESHOLDS.warn,
      TURBIDITY_THRESHOLDS.danger,
    )
  }
  if (inputs.tds != null) {
    subIndices.tds = subIndexLowerIsBetter(inputs.tds, TDS_THRESHOLDS.warn, TDS_THRESHOLDS.danger)
  }
  if (inputs.ec != null) {
    subIndices.ec = subIndexLowerIsBetter(inputs.ec, EC_THRESHOLDS.warn, EC_THRESHOLDS.danger)
  }
  if (inputs.temperature != null) {
    subIndices.temperature = temperatureSubIndex(inputs.temperature)
  }

  const included = ALL_PARAMS.filter((p) => p in subIndices)
  const excluded = ALL_PARAMS.filter((p) => !(p in subIndices))

  if (included.length === 0) {
    return { score: null, band: 'unknown', color: WQI_BAND_COLOR.unknown, excluded }
  }

  const weightSum = included.reduce((sum, p) => sum + WEIGHTS[p], 0)
  const weighted = included.reduce(
    (sum, p) => sum + subIndices[p]! * (WEIGHTS[p] / weightSum),
    0,
  )

  const score = Math.round(clamp(weighted, 0, 100))
  const band: WqiBand =
    score >= WQI_THRESHOLDS.good ? 'good' : score >= WQI_THRESHOLDS.moderate ? 'moderate' : 'poor'

  return { score, band, color: WQI_BAND_COLOR[band], excluded }
}

/**
 * Compute WQI from a live sensor reading. Only scores turbidity when a genuine NTU value
 * is available (`turbidityNtu`, or `turbidity` explicitly labeled NTU via `turbidityUnit`) —
 * a raw uncalibrated ADC reading is never fed into the NTU thresholds.
 */
export function wqiFromReading(
  r: Pick<
    SensorReading,
    'temperature' | 'turbidity' | 'turbidityNtu' | 'turbidityUnit' | 'tds' | 'ec'
  >,
): WqiResult {
  return computeWqi({
    temperature: r.temperature,
    turbidity: r.turbidityNtu ?? (r.turbidityUnit === 'NTU' ? r.turbidity : null),
    tds: r.tds,
    ec: r.ec,
  })
}

/**
 * Compute WQI from a `/history` row. Shares the same sub-index logic as live readings.
 * `HistoryRow.turbidity` is always raw ADC (see types.ts), so only `turbidityNtu` is used.
 */
export function wqiFromHistoryRow(row: HistoryRow): WqiResult {
  return computeWqi({
    temperature: row.temperature,
    turbidity: row.turbidityNtu,
    tds: row.tds,
    ec: row.ec,
  })
}
