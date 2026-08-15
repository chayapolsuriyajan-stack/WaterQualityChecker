/**
 * Responsive grid of the 4 live metric cards (Temperature, Turbidity, TDS, EC),
 * driven from PARAM_ORDER/PARAM_META instead of 4 hand-written blocks with
 * duplicated labels/units/thresholds. Owns which param's detail modal is open.
 */
import { useState } from 'react'
import {
  EC_THRESHOLDS,
  isSensorFault,
  TDS_THRESHOLDS,
  TEMPERATURE_THRESHOLDS,
  TURBIDITY_THRESHOLDS,
} from '@/lib/thresholds'
import { useT } from '@/lib/i18n'
import { PARAM_META, PARAM_ORDER, type ParamKey } from '@/lib/paramMeta'
import type { SensorReading } from '@/lib/types'
import type { SensorSeries } from '@/lib/useSensorSocket'
import { ParamCard } from './ParamCard'
import { ParamDetailDialog } from './ParamDetailDialog'

interface ParamGridProps {
  reading: SensorReading | null
  series: SensorSeries
}

/** Sparkline threshold + label per param, kept out of paramMeta since it's dashboard-card-only. */
const SPARKLINE_THRESHOLD: Record<ParamKey, { value: number; label: string }> = {
  temperature: { value: TEMPERATURE_THRESHOLDS.max, label: `${TEMPERATURE_THRESHOLDS.max}${TEMPERATURE_THRESHOLDS.unit} max` },
  turbidity: { value: TURBIDITY_THRESHOLDS.warn, label: `${TURBIDITY_THRESHOLDS.warn} ${TURBIDITY_THRESHOLDS.unit}` },
  tds: { value: TDS_THRESHOLDS.warn, label: `${TDS_THRESHOLDS.warn} ${TDS_THRESHOLDS.unit}` },
  ec: { value: EC_THRESHOLDS.warn, label: `${EC_THRESHOLDS.warn} ${EC_THRESHOLDS.unit}` },
}

export function ParamGrid({ reading, series }: ParamGridProps) {
  const { t } = useT()
  const [openParam, setOpenParam] = useState<ParamKey | null>(null)

  const turbidityIsNtu = reading?.turbidityUnit === 'NTU'
  const turbidityValue =
    reading === null ? null : turbidityIsNtu ? reading.turbidityNtu ?? reading.turbidity : reading.turbidity

  function valueFor(param: ParamKey): number | null {
    if (reading === null) return null
    switch (param) {
      case 'temperature':
        return reading.temperature
      case 'turbidity':
        return turbidityValue
      case 'tds':
        return reading.tds
      case 'ec':
        return reading.ec
    }
  }

  function unitFor(param: ParamKey): string {
    if (param === 'turbidity') return turbidityIsNtu ? 'NTU' : 'ADC'
    return PARAM_META[param].unit
  }

  /** Omitted for uncalibrated turbidity, whose displayed unit is raw "ADC", not "NTU". */
  function unitFullNameKeyFor(param: ParamKey) {
    if (param === 'turbidity' && !turbidityIsNtu) return undefined
    return PARAM_META[param].unitFullNameKey
  }

  function precisionFor(param: ParamKey): number {
    if (param === 'turbidity') return turbidityIsNtu ? PARAM_META.turbidity.precision : 0
    return PARAM_META[param].precision
  }

  const openMeta = openParam ? PARAM_META[openParam] : null
  const openScorable = openParam === 'turbidity' ? turbidityIsNtu : true

  /** Same priority as RangeWarning: uncalibrated (turbidity only) > sensor fault > no hint.
   * Uncalibrated turbidity's raw ADC value isn't in NTU, so it's never checked against
   * sensorFaultBelow (which is an NTU threshold) -- these two states can't collide. */
  function hintFor(param: ParamKey): string | undefined {
    if (param === 'turbidity' && !turbidityIsNtu) return t('common.uncalibrated')
    const value = valueFor(param)
    if (value !== null && isSensorFault(param, value)) return t('quickview.sensorFault')
    return undefined
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-2">
        {PARAM_ORDER.map((param, index) => {
          const meta = PARAM_META[param]
          const { value: threshold, label: thresholdLabel } = SPARKLINE_THRESHOLD[param]
          const isTurbidity = param === 'turbidity'
          return (
            <ParamCard
              key={param}
              index={index}
              labelKey={meta.labelKey}
              value={valueFor(param)}
              unit={unitFor(param)}
              unitFullNameKey={unitFullNameKeyFor(param)}
              precision={precisionFor(param)}
              param={isTurbidity ? (turbidityIsNtu ? 'turbidity' : undefined) : param}
              threshold={threshold}
              thresholdLabel={thresholdLabel}
              showThreshold={isTurbidity ? turbidityIsNtu : true}
              hint={hintFor(param)}
              series={series[param]}
              onOpen={() => setOpenParam(param)}
            />
          )
        })}
      </div>
      <ParamDetailDialog
        param={openParam}
        onClose={() => setOpenParam(null)}
        liveValue={openParam ? valueFor(openParam) : null}
        liveUnit={openMeta ? unitFor(openParam as ParamKey) : undefined}
        scorable={openScorable}
      />
    </>
  )
}
