/**
 * Dashboard (home) view: top WQI history chart, center live param grid,
 * bottom radial safety gauges. Owns the single useSensorSocket subscription
 * and distributes reading/series down to its children.
 */
import { useSensorSocket } from '@/lib/useSensorSocket'
import { WqiHistoryChart } from './WqiHistoryChart'
import { ParamGrid } from './ParamGrid'
import { GaugeRow } from './GaugeRow'

export function DashboardView() {
  const { reading, series } = useSensorSocket()

  return (
    <div className="flex flex-col gap-6">
      <WqiHistoryChart />
      <ParamGrid reading={reading} series={series} />
      <GaugeRow reading={reading} />
    </div>
  )
}
