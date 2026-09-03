/**
 * Station picker for the Dashboard tab: one tab per ESP32 board that has reported this
 * session (see useSensorSocket's `stations` map), switching which station's live data and
 * history the rest of the dashboard shows. Renders nothing for a single-station deployment
 * (the common case -- one board, never given a custom name) so it doesn't clutter the UI
 * with a switcher that has nothing to switch between.
 */
import { Radio } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useT } from '@/lib/i18n'
import { useSensorData } from '@/lib/SensorProvider'

/** "default" is the backend's sentinel for a board with no station name provisioned (see
 * main.py's DEFAULT_STATION) -- shown as a friendly label instead of the raw key. */
export function stationLabel(station: string, t: ReturnType<typeof useT>['t']): string {
  return station === 'default' ? t('station.defaultLabel') : station
}

export function StationSwitcher() {
  const { t } = useT()
  const { stationNames, selectedStation, setSelectedStation } = useSensorData()

  if (stationNames.length <= 1) return null

  return (
    <div className="flex items-center gap-2">
      <Radio className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Tabs value={selectedStation} onValueChange={setSelectedStation}>
        <TabsList>
          {stationNames.map((station) => (
            <TabsTrigger key={station} value={station}>
              {stationLabel(station, t)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )
}
