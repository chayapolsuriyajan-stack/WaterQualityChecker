/**
 * Dashboard (home) view: top WQI history chart, center live param grid,
 * bottom radial safety gauges. Reads the shared sensor context (single
 * /ws/app socket owned by SensorProvider) and distributes reading/series
 * down to its children.
 */
import { useState } from 'react'
import { useSelectedStationData, useSensorData } from '@/lib/SensorProvider'
import type { HistoryWindow } from '@/lib/types'
import { StationSwitcher } from '@/components/shell/StationSwitcher'
import { WqiHistoryChart } from './WqiHistoryChart'
import { WaterFlowChart } from './WaterFlowChart'
import { WaterUsageChart } from './WaterUsageChart'
import { ParamGrid } from './ParamGrid'
import { GaugeRow } from './GaugeRow'

export function DashboardView() {
  const { reading, series } = useSelectedStationData()
  const { selectedStation } = useSensorData()
  // Single history window shared by the WQI chart and every parameter detail
  // chart, so changing the time range anywhere moves every graph together.
  const [window, setWindow] = useState<HistoryWindow>('15m')

  return (
    <div className="flex flex-col gap-6">
      <StationSwitcher />
      <WqiHistoryChart window={window} onWindowChange={setWindow} station={selectedStation} />
      <ParamGrid reading={reading} series={series} window={window} onWindowChange={setWindow} station={selectedStation} />
      <WaterFlowChart window={window} onWindowChange={setWindow} station={selectedStation} />
      <WaterUsageChart station={selectedStation} />
      <GaugeRow reading={reading} />
    </div>
  )
}
