/**
 * Dashboard (home) view: top WQI history chart, center live param grid,
 * bottom radial safety gauges. Reads the shared sensor context (single
 * /ws/app socket owned by SensorProvider) and distributes reading/series
 * down to its children.
 */
import { useState } from 'react'
import { useSensorData } from '@/lib/SensorProvider'
import type { HistoryWindow } from '@/lib/types'
import { WqiHistoryChart } from './WqiHistoryChart'
import { ParamGrid } from './ParamGrid'
import { GaugeRow } from './GaugeRow'

export function DashboardView() {
  const { reading, series } = useSensorData()
  // Single history window shared by the WQI chart and every parameter detail
  // chart, so changing the time range anywhere moves every graph together.
  const [window, setWindow] = useState<HistoryWindow>('15m')

  return (
    <div className="flex flex-col gap-6">
      <WqiHistoryChart window={window} onWindowChange={setWindow} />
      <ParamGrid reading={reading} series={series} window={window} onWindowChange={setWindow} />
      <GaugeRow reading={reading} />
    </div>
  )
}
