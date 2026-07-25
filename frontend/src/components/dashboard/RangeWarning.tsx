/**
 * Two-sided out-of-range banner for the parameter detail modal. Shows only
 * when rangeStatusFor(...).direction !== 'ok'. Turbidity readings implausibly
 * near zero get the sensor-fault copy instead of a "too low" water warning
 * (see isSensorFault in lib/thresholds.ts).
 */
import { AlertTriangle } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { isSensorFault, type RangeParam, type RangeStatus } from '@/lib/thresholds'

interface RangeWarningProps {
  param: RangeParam
  paramLabel: string
  value: number
  unit: string
  precision: number
  range: RangeStatus
}

export function RangeWarning({ param, paramLabel, value, unit, precision, range }: RangeWarningProps) {
  const { t } = useT()

  if (range.direction === 'ok') return null

  const sensorFault = param === 'turbidity' && range.direction === 'low' && isSensorFault(param, value)

  const message = sensorFault
    ? t('detail.checkSensor')
    : t(range.direction === 'high' ? 'detail.tooHigh' : 'detail.tooLow', {
        param: paramLabel,
        value: value.toFixed(precision),
        unit,
      })

  const toneClass =
    range.status === 'danger'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : 'border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]'

  return (
    <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${toneClass}`} role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>{message}</p>
    </div>
  )
}
