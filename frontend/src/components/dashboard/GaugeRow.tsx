/**
 * Bottom row of 3 radial safety gauges (Turbidity, TDS, EC) sized against
 * their danger threshold from lib/thresholds.ts.
 */
import { EC_THRESHOLDS, TDS_THRESHOLDS, TURBIDITY_THRESHOLDS } from '@/lib/thresholds'
import type { SensorReading } from '@/lib/types'
import { RadialGauge } from './RadialGauge'

interface GaugeRowProps {
  reading: SensorReading | null
}

export function GaugeRow({ reading }: GaugeRowProps) {
  const turbidityValue =
    reading === null ? null : reading.turbidityUnit === 'NTU' ? reading.turbidityNtu ?? reading.turbidity : null

  return (
    <div className="grid grid-cols-1 gap-6 rounded-xl border bg-card p-4 sm:grid-cols-3">
      <RadialGauge
        labelTh="ความขุ่น"
        labelEn="Turbidity"
        value={turbidityValue}
        unit="NTU"
        precision={1}
        param="turbidity"
        max={TURBIDITY_THRESHOLDS.danger * 1.2}
        thresholdWarn={TURBIDITY_THRESHOLDS.warn}
        thresholdDanger={TURBIDITY_THRESHOLDS.danger}
      />
      <RadialGauge
        labelTh="สารละลายทั้งหมด"
        labelEn="TDS"
        value={reading?.tds ?? null}
        unit="ppm"
        precision={0}
        param="tds"
        max={TDS_THRESHOLDS.danger * 1.2}
        thresholdWarn={TDS_THRESHOLDS.warn}
        thresholdDanger={TDS_THRESHOLDS.danger}
      />
      <RadialGauge
        labelTh="การนำไฟฟ้า"
        labelEn="EC"
        value={reading?.ec ?? null}
        unit="µS/cm"
        precision={0}
        param="ec"
        max={EC_THRESHOLDS.danger * 1.2}
        thresholdWarn={EC_THRESHOLDS.warn}
        thresholdDanger={EC_THRESHOLDS.danger}
      />
    </div>
  )
}
