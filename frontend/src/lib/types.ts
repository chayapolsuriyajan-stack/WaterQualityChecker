/**
 * Shared types for the Aqua Monitor frontend.
 * Mirrors the backend's `/update`/`/history` payload shape (see main.py).
 */

/** A single live sensor reading pushed over `/ws/app` (sensor_update payload). */
export interface SensorReading {
  /** Which ESP32 board this reading came from. `"default"` for a board with no station
   * name provisioned (see CLAUDE.md's WiFi provisioning section, STATION_SET). */
  station: string
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
  /** Instantaneous flow rate in L/min. Null if the backend hasn't received a flow reading yet. */
  flowRate: number | null
  /** Cumulative liters used since local midnight (resets daily, see GET /flow/usage). */
  waterUsageToday: number | null
  timestamp?: number
}

/** One row from `GET /history?window=`. */
export interface HistoryRow {
  /** Epoch milliseconds. */
  timestamp: number
  /** Which station this row belongs to -- see SensorReading.station. */
  station: string
  temperature: number | null
  /** Raw ADC turbidity value, as logged historically. */
  turbidity: number | null
  turbidityNtu: number | null
  tds: number | null
  ec: number | null
  flowRate: number | null
}

/** One day's total from `GET /flow/usage`. */
export interface DailyUsageRow {
  /** Local YYYY-MM-DD date string. */
  date: string
  totalLiters: number
}

/** Full response from `GET /flow/usage`. */
export interface FlowUsageResponse {
  today: number
  days: DailyUsageRow[]
}

export type HistoryWindow = '5m' | '15m' | '1h' | '3h' | '12h' | '24h'

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

export interface FlowCalibrationPoint extends CalibrationPointBase {
  rawPulses: number
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
  flow: {
    model: 'kfactor'
    points: FlowCalibrationPoint[]
    coefficients: { k: number } | null
    updated: string | null
  }
  latestRaw: {
    turbidity: number | null
    tdsVoltage: number | null
    temperature: number | null
    flowRaw: number | null
  }
}

/** One network from `POST /wifi/scan`, deduped by SSID and sorted strongest-first. */
export interface WifiNetwork {
  ssid: string
  rssi: number
  secured: boolean
}

/** `GET /wifi/status`'s success shape. */
export interface WifiStatus {
  connected: boolean
  ssid: string
  ip: string
  rssi: number
}

/**
 * `GET /wifi/backend`'s success shape -- the fixed-backend-host override (esp32.ino's
 * BACKEND_SET/BACKEND_CLEAR), which lets the board reach a backend on a different network
 * than same-LAN UDP discovery could ever find. `url` is whatever the firmware is currently
 * using either way (the fixed host, or its last discovery result).
 */
export interface WifiBackendStatus {
  fixed: boolean
  host: string
  url: string
  hasApiKey: boolean
  https: boolean
}

/**
 * `STATION_STATUS`'s reply shape (esp32.ino's STATION_SET/STATION_CLEAR/STATION_STATUS) --
 * the multi-station identity a board tags every `/update` POST with (main.py's
 * DEFAULT_STATION/`station` query param). `name` is empty when never provisioned, meaning
 * the board omits `station` from its payload and the backend's own "default" sentinel applies.
 */
export interface WifiStationStatus {
  name: string
}
