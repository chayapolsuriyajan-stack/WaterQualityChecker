/**
 * Shared types for the Aqua Monitor frontend.
 * Mirrors the backend contract documented in AQUA_MONITOR_PLAN.md ("Backend contract").
 */

/** A single live sensor reading pushed over `/ws/app` (sensor_update payload). */
export interface SensorReading {
  temperature: number
  /** Turbidity in whatever unit `turbidityUnit` says (NTU once calibrated, else raw ADC). */
  turbidity: number
  /** Calibrated NTU value, or null if turbidity hasn't been calibrated yet. */
  turbidityNtu: number | null
  /** Always the raw ADC reading, regardless of calibration state. */
  turbidityRaw: number
  turbidityUnit: 'NTU' | 'ADC'
  /** TDS in ppm (calibrated). Null if the backend hasn't received a tds/tdsVoltage reading yet. */
  tds: number | null
  /** Raw TDS sensor voltage. */
  tdsVoltage: number
  /** Electrical conductivity in µS/cm, derived from tds. Null when tds is unavailable. */
  ec: number | null
  timestamp?: number
}

/** One row from `GET /history?window=`. */
export interface HistoryRow {
  /** Epoch milliseconds. */
  timestamp: number
  temperature: number | null
  /** Raw ADC turbidity value, as logged historically. */
  turbidity: number | null
  turbidityNtu: number | null
  tds: number | null
  ec: number | null
}

export type HistoryWindow = '5m' | '15m' | '1h' | '3h' | '24h'

interface CalibrationPointBase {
  reference: number
  label?: string
}

export interface TurbidityCalibrationPoint extends CalibrationPointBase {
  raw: number
}

export interface TdsCalibrationPoint extends CalibrationPointBase {
  rawVoltage: number
  temperature?: number
}

/** Full state returned by `GET /calibration`. */
export interface CalibrationState {
  mode: boolean
  turbidity: {
    model: 'linear2'
    points: TurbidityCalibrationPoint[]
    coefficients: { slope: number; intercept: number } | null
    updated: string | null
  }
  tds: {
    model: 'kfactor'
    points: TdsCalibrationPoint[]
    coefficients: { k: number } | null
    updated: string | null
  }
  latestRaw: {
    turbidity: number | null
    tdsVoltage: number | null
    temperature: number | null
  }
}
