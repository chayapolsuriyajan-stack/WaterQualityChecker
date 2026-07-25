/**
 * Responsive grid of the 4 live metric cards (Temperature, Turbidity, TDS, EC).
 * 2x2 at lg+, 2-col at md, 1-col on phone.
 */
import {
  EC_THRESHOLDS,
  TDS_THRESHOLDS,
  TEMPERATURE_THRESHOLDS,
  TURBIDITY_THRESHOLDS,
} from '@/lib/thresholds'
import type { SensorReading } from '@/lib/types'
import type { SensorSeries } from '@/lib/useSensorSocket'
import { ParamCard } from './ParamCard'

interface ParamGridProps {
  reading: SensorReading | null
  series: SensorSeries
}

export function ParamGrid({ reading, series }: ParamGridProps) {
  const turbidityValue =
    reading === null ? null : reading.turbidityUnit === 'NTU' ? reading.turbidityNtu ?? reading.turbidity : reading.turbidity
  const turbidityUnit = reading?.turbidityUnit === 'NTU' ? 'NTU' : 'ADC'

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-2">
      <ParamCard
        index={0}
        labelTh="อุณหภูมิ"
        labelEn="Temperature"
        value={reading?.temperature ?? null}
        unit="°C"
        param="temperature"
        threshold={TEMPERATURE_THRESHOLDS.max}
        thresholdLabel={`${TEMPERATURE_THRESHOLDS.max}°C max`}
        series={series.temperature}
      />
      <ParamCard
        index={1}
        labelTh="ความขุ่น"
        labelEn="Turbidity"
        value={turbidityValue}
        unit={turbidityUnit}
        precision={turbidityUnit === 'NTU' ? 1 : 0}
        param="turbidity"
        threshold={TURBIDITY_THRESHOLDS.warn}
        thresholdLabel={`${TURBIDITY_THRESHOLDS.warn} ${TURBIDITY_THRESHOLDS.unit}`}
        series={series.turbidity}
      />
      <ParamCard
        index={2}
        labelTh="สารละลายทั้งหมด"
        labelEn="TDS"
        value={reading?.tds ?? null}
        unit="ppm"
        precision={0}
        param="tds"
        threshold={TDS_THRESHOLDS.warn}
        thresholdLabel={`${TDS_THRESHOLDS.warn} ${TDS_THRESHOLDS.unit}`}
        series={series.tds}
      />
      <ParamCard
        index={3}
        labelTh="การนำไฟฟ้า"
        labelEn="EC"
        value={reading?.ec ?? null}
        unit="µS/cm"
        precision={0}
        param="ec"
        threshold={EC_THRESHOLDS.warn}
        thresholdLabel={`${EC_THRESHOLDS.warn} ${EC_THRESHOLDS.unit}`}
        series={series.ec}
      />
    </div>
  )
}
