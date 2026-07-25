/**
 * Frontend-derived Water Quality Index (WQI).
 *
 * Per AQUA_MONITOR_PLAN.md: "WQI: frontend-derived from live params (no backend WQI)".
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
 * Final score = weighted average of sub-indices, rounded to nearest integer.
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

const WEIGHTS = {
  turbidity: 0.35,
  tds: 0.35,
  ec: 0.1,
  temperature: 0.2,
} as const

export type WqiBand = 'good' | 'moderate' | 'poor'

export interface WqiResult {
  score: number
  band: WqiBand
  color: string
}

const WQI_BAND_COLOR: Record<WqiBand, string> = {
  good: '#22c55e',
  moderate: '#f59e0b',
  poor: '#ef4444',
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
  temperature: number
  turbidity: number
  tds: number
  ec: number
}

function computeWqi(inputs: WqiInputs): WqiResult {
  const turbiditySub = subIndexLowerIsBetter(
    inputs.turbidity,
    TURBIDITY_THRESHOLDS.warn,
    TURBIDITY_THRESHOLDS.danger,
  )
  const tdsSub = subIndexLowerIsBetter(inputs.tds, TDS_THRESHOLDS.warn, TDS_THRESHOLDS.danger)
  const ecSub = subIndexLowerIsBetter(inputs.ec, EC_THRESHOLDS.warn, EC_THRESHOLDS.danger)
  const temperatureSub = temperatureSubIndex(inputs.temperature)

  const weighted =
    turbiditySub * WEIGHTS.turbidity +
    tdsSub * WEIGHTS.tds +
    ecSub * WEIGHTS.ec +
    temperatureSub * WEIGHTS.temperature

  const score = Math.round(clamp(weighted, 0, 100))
  const band: WqiBand =
    score >= WQI_THRESHOLDS.good ? 'good' : score >= WQI_THRESHOLDS.moderate ? 'moderate' : 'poor'

  return { score, band, color: WQI_BAND_COLOR[band] }
}

/** Compute WQI from a live sensor reading. Uses turbidityNtu when present, else raw turbidity. */
export function wqiFromReading(
  r: Pick<SensorReading, 'temperature' | 'turbidity' | 'turbidityNtu' | 'tds' | 'ec'>,
): WqiResult {
  return computeWqi({
    temperature: r.temperature,
    turbidity: r.turbidityNtu ?? r.turbidity,
    tds: r.tds,
    ec: r.ec,
  })
}

/** Compute WQI from a `/history` row. Shares the same sub-index logic as live readings. */
export function wqiFromHistoryRow(row: HistoryRow): WqiResult {
  return computeWqi({
    temperature: row.temperature,
    turbidity: row.turbidityNtu ?? row.turbidity,
    tds: row.tds,
    ec: row.ec,
  })
}
