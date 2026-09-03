/**
 * Single per-parameter metadata definition (label/about/impact/recommendation
 * message keys, unit, display precision, icon, and which HistoryRow field to
 * plot) so ParamGrid and the parameter detail modal stop duplicating this
 * information in their own local arrays/objects.
 */
import type { LucideIcon } from 'lucide-react'
import { Activity, Droplets, FlaskConical, Thermometer, Waves } from 'lucide-react'
import type { MessageKey } from './strings'

export type ParamKey = 'temperature' | 'turbidity' | 'tds' | 'ec' | 'flow'

export interface ParamMeta {
  key: ParamKey
  labelKey: MessageKey
  /**
   * Spelled-out name, for params whose `labelKey` is an acronym (TDS, EC) that
   * isn't self-explanatory to a non-technical viewer. Shown alongside the
   * label in the detail modal. Omitted for temperature/turbidity, whose
   * label is already a plain word.
   */
  fullNameKey?: MessageKey
  /**
   * Spelled-out name of the unit symbol (e.g. "Nephelometric Turbidity
   * Units" for NTU), for params whose `unit` is an abbreviation that isn't
   * self-explanatory to a non-technical viewer. Shown alongside the unit
   * wherever it renders. Omitted for temperature, whose unit (°C) is
   * self-explanatory.
   */
  unitFullNameKey?: MessageKey
  aboutKey: MessageKey
  /**
   * Omitted for params with no good/warn/danger judgment (currently just `flow` — a plain
   * quantity, not a water-quality score). `ParamDetailDialog`/`ParamCard` skip the
   * Impact/Recommendation cards and status coloring entirely when these are absent, the same
   * way they already skip them for an unscorable/uncalibrated turbidity reading.
   */
  impactKey?: MessageKey
  recommendationKey?: MessageKey
  unit: string
  /** Decimal places for display, e.g. value.toFixed(precision). */
  precision: number
  icon: LucideIcon
  /**
   * Which field on a `HistoryRow` (lib/types.ts) to plot in the detail chart.
   * Turbidity plots `turbidityNtu` (the calibrated NTU column) — a HistoryRow's
   * `turbidity` field is always raw ADC, never a value to score/chart directly.
   */
  historyField: 'temperature' | 'turbidityNtu' | 'tds' | 'ec' | 'flowRate'
}

export const PARAM_META: Record<ParamKey, ParamMeta> = {
  temperature: {
    key: 'temperature',
    labelKey: 'param.temperature.label',
    aboutKey: 'param.temperature.about',
    impactKey: 'param.temperature.impact',
    recommendationKey: 'param.temperature.recommendation',
    unit: '°C',
    precision: 1,
    icon: Thermometer,
    historyField: 'temperature',
  },
  turbidity: {
    key: 'turbidity',
    labelKey: 'param.turbidity.label',
    fullNameKey: 'param.turbidity.fullName',
    aboutKey: 'param.turbidity.about',
    impactKey: 'param.turbidity.impact',
    recommendationKey: 'param.turbidity.recommendation',
    unit: 'NTU',
    unitFullNameKey: 'unit.ntu.fullName',
    precision: 1,
    icon: Droplets,
    historyField: 'turbidityNtu',
  },
  tds: {
    key: 'tds',
    labelKey: 'param.tds.label',
    fullNameKey: 'param.tds.fullName',
    aboutKey: 'param.tds.about',
    impactKey: 'param.tds.impact',
    recommendationKey: 'param.tds.recommendation',
    unit: 'ppm',
    unitFullNameKey: 'unit.ppm.fullName',
    precision: 0,
    icon: FlaskConical,
    historyField: 'tds',
  },
  ec: {
    key: 'ec',
    labelKey: 'param.ec.label',
    fullNameKey: 'param.ec.fullName',
    aboutKey: 'param.ec.about',
    impactKey: 'param.ec.impact',
    recommendationKey: 'param.ec.recommendation',
    unit: 'µS/cm',
    unitFullNameKey: 'unit.ecUnit.fullName',
    precision: 0,
    icon: Activity,
    historyField: 'ec',
  },
  flow: {
    key: 'flow',
    labelKey: 'param.flow.label',
    aboutKey: 'param.flow.about',
    // No impactKey/recommendationKey -- flow rate is a plain quantity, not a water-quality
    // judgment (see the ParamMeta interface comment above).
    unit: 'L/min',
    precision: 1,
    icon: Waves,
    historyField: 'flowRate',
  },
}

export const PARAM_ORDER: ParamKey[] = ['temperature', 'turbidity', 'tds', 'ec', 'flow']
