/**
 * Vertical (horizontal-scroll on phone) picker for the 4 calibratable "sensors"
 * shown on the Calibration view. Only turbidity/tds actually have coefficients;
 * temperature/ec are informational read-only entries (see CalibrationView).
 */
import type { LucideIcon } from 'lucide-react'
import { Droplet, Thermometer, Waves, Zap } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui/badge'
import type { CalibrationState } from '@/lib/types'

export type CalibrationSensorId = 'temperature' | 'turbidity' | 'tds' | 'ec'

interface SensorDef {
  id: CalibrationSensorId
  labelTh: string
  labelEn: string
  icon: LucideIcon
}

const SENSORS: SensorDef[] = [
  { id: 'temperature', labelTh: 'อุณหภูมิ', labelEn: 'Temperature', icon: Thermometer },
  { id: 'turbidity', labelTh: 'ความขุ่น', labelEn: 'Turbidity', icon: Waves },
  { id: 'tds', labelTh: 'TDS', labelEn: 'TDS', icon: Droplet },
  { id: 'ec', labelTh: 'ค่าการนำไฟฟ้า', labelEn: 'EC', icon: Zap },
]

interface SensorListProps {
  active: CalibrationSensorId
  onSelect: (id: CalibrationSensorId) => void
  calibration?: CalibrationState
  className?: string
}

/** null = not applicable (temperature/ec have no coefficients to be "calibrated"). */
function isCalibrated(id: CalibrationSensorId, calibration?: CalibrationState): boolean | null {
  if (!calibration) return null
  if (id === 'turbidity') return calibration.turbidity.coefficients !== null
  if (id === 'tds') return calibration.tds.coefficients !== null
  return null
}

export function SensorList({ active, onSelect, calibration, className }: SensorListProps) {
  return (
    <nav
      aria-label="Sensor selection / เลือกเซนเซอร์"
      className={cn(
        'flex gap-2 overflow-x-auto pb-1 sm:flex-col sm:overflow-visible sm:pb-0',
        className,
      )}
    >
      {SENSORS.map((sensor) => {
        const Icon = sensor.icon
        const isActive = sensor.id === active
        const calibrated = isCalibrated(sensor.id, calibration)
        return (
          <button
            key={sensor.id}
            type="button"
            onClick={() => onSelect(sensor.id)}
            aria-current={isActive ? 'true' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm font-medium transition-colors sm:shrink',
              isActive
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="whitespace-nowrap sm:whitespace-normal">
              {sensor.labelTh} <span className="text-muted-foreground/70">/ {sensor.labelEn}</span>
            </span>
            {calibrated !== null && (
              <Badge variant={calibrated ? 'default' : 'outline'} className="ml-auto shrink-0 text-[10px]">
                {calibrated ? 'OK' : '—'}
              </Badge>
            )}
          </button>
        )
      })}
    </nav>
  )
}
