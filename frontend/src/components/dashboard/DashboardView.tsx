/**
 * Dashboard (home) view: top WQI history chart, center live param grid,
 * bottom radial safety gauges. Reads the shared sensor context (single
 * /ws/app socket owned by SensorProvider) and distributes reading/series
 * down to its children.
 */
import { useSensorData } from '@/lib/SensorProvider'
import { WqiHistoryChart } from './WqiHistoryChart'
import { ParamGrid } from './ParamGrid'
import { GaugeRow } from './GaugeRow'

export function DashboardView() {
  const { reading, series } = useSensorData()

  return (
    <div className="flex flex-col gap-6">
      <WqiHistoryChart />
      <ParamGrid reading={reading} series={series} />
      <GaugeRow reading={reading} />
    </div>
  )
}
