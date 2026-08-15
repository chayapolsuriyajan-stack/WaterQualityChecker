/**
 * Compact "at a glance" card for the Dashboard tab's right column: overall
 * WQI badge, a one-line language-aware analysis sentence (see
 * `analysisText` below), and one row per live param (icon, value, status
 * dot). A pure derived view over `useSensorData()` -- no new fetching/WS
 * handling.
 *
 * A param whose reading is implausibly near zero (see `isSensorFault` in
 * lib/thresholds.ts) shows a "not connected" warning instead of the normal
 * status dot, rather than silently presenting e.g. a disconnected TDS
 * probe's ~0 ppm as if it were a genuine reading.
 */
import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { PARAM_META, PARAM_ORDER, type ParamKey } from '@/lib/paramMeta'
import { useSensorData } from '@/lib/SensorProvider'
import { colorFor, isSensorFault, rangeStatusFor } from '@/lib/thresholds'
import { wqiFromReading, type WqiBand } from '@/lib/wqi'
import type { MessageKey } from '@/lib/strings'
import type { SensorReading } from '@/lib/types'

const WQI_BAND_KEY: Record<WqiBand, MessageKey> = {
  good: 'wqi.good',
  moderate: 'wqi.moderate',
  poor: 'wqi.poor',
  unknown: 'wqi.unknown',
}

const WQI_BAND_BADGE_CLASS: Record<WqiBand, string> = {
  good: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-transparent',
  moderate: 'bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))] border-transparent',
  poor: 'bg-destructive/15 text-destructive border-transparent',
  unknown: 'bg-muted text-muted-foreground border-transparent',
}

/** Same turbidity NTU-vs-raw-ADC selection as ParamGrid.tsx -- never score/display raw ADC as if it were NTU. */
function valueFor(reading: SensorReading, param: ParamKey): number | null {
  switch (param) {
    case 'temperature':
      return reading.temperature
    case 'turbidity':
      return reading.turbidityUnit === 'NTU' ? reading.turbidityNtu ?? reading.turbidity : null
    case 'tds':
      return reading.tds
    case 'ec':
      return reading.ec
  }
}

function unitFor(reading: SensorReading, param: ParamKey): string {
  if (param === 'turbidity' && reading.turbidityUnit !== 'NTU') return 'ADC'
  return PARAM_META[param].unit
}

/** Omitted for uncalibrated turbidity, whose displayed unit is raw "ADC", not "NTU". */
function unitFullNameKeyFor(reading: SensorReading, param: ParamKey) {
  if (param === 'turbidity' && reading.turbidityUnit !== 'NTU') return undefined
  return PARAM_META[param].unitFullNameKey
}

/**
 * One-line, language-aware analysis of the current situation: leads with any
 * likely sensor faults (a faulting param's apparent "danger" status is a
 * false signal from the fault itself, not a real water reading, so it's
 * reported separately rather than folded into the "watch" list below),
 * otherwise names any params outside their normal range alongside the WQI
 * band, otherwise a plain "all normal" line. `noData` covers the case where
 * nothing has ever been received yet.
 */
function analysisText(reading: SensorReading | null, t: ReturnType<typeof useT>['t']): string {
  if (!reading) return t('quickview.analysis.noData')

  const faulting: ParamKey[] = []
  const watching: ParamKey[] = []

  for (const param of PARAM_ORDER) {
    const value = valueFor(reading, param)
    if (value === null) continue
    if (isSensorFault(param, value)) {
      faulting.push(param)
      continue
    }
    if (rangeStatusFor(param, value).direction !== 'ok') {
      watching.push(param)
    }
  }

  const labelList = (params: ParamKey[]) => params.map((p) => t(PARAM_META[p].labelKey)).join(', ')

  const sentences: string[] = []
  if (faulting.length > 0) {
    sentences.push(t('quickview.analysis.fault', { params: labelList(faulting) }))
  }
  if (watching.length > 0) {
    sentences.push(
      t('quickview.analysis.watch', {
        band: t(WQI_BAND_KEY[wqiFromReading(reading).band]),
        params: labelList(watching),
      }),
    )
  }
  if (sentences.length === 0) {
    sentences.push(t('quickview.analysis.good'))
  }
  return sentences.join(' ')
}

interface QuickViewRowProps {
  param: ParamKey
  reading: SensorReading | null
}

function QuickViewRow({ param, reading }: QuickViewRowProps) {
  const { t } = useT()
  const meta = PARAM_META[param]
  const Icon = meta.icon
  const value = reading ? valueFor(reading, param) : null
  const fault = value !== null && isSensorFault(param, value)
  const scorable = param === 'turbidity' ? reading?.turbidityUnit === 'NTU' : true
  const color =
    value === null || !scorable ? 'hsl(var(--muted-foreground))' : colorFor(param, value)
  const unitFullNameKey = reading ? unitFullNameKeyFor(reading, param) : undefined
  const unitTitle = value !== null && unitFullNameKey ? t(unitFullNameKey) : undefined

  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate text-xs text-muted-foreground">{t(meta.labelKey)}</span>
      </div>
      {fault ? (
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-[hsl(var(--warning))]">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          {t('quickview.sensorFault')}
        </span>
      ) : (
        <span
          className="flex shrink-0 items-center gap-1.5 text-xs font-medium tabular-nums text-foreground"
          title={unitTitle}
        >
          {value === null ? '—' : `${value.toFixed(meta.precision)} ${unitFor(reading!, param)}`}
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
        </span>
      )}
    </div>
  )
}

interface QuickViewSummaryProps {
  className?: string
}

export function QuickViewSummary({ className }: QuickViewSummaryProps) {
  const { reading } = useSensorData()
  const { t } = useT()
  const wqi = reading ? wqiFromReading(reading) : { score: null, band: 'unknown' as WqiBand }

  return (
    <div className={cn('rounded-xl border border-border bg-card/70 p-4 shadow-sm backdrop-blur-md', className)}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{t('quickview.title')}</h3>
        <Badge variant="outline" className={cn('shrink-0 whitespace-nowrap', WQI_BAND_BADGE_CLASS[wqi.band])}>
          {wqi.score === null ? t(WQI_BAND_KEY[wqi.band]) : `${wqi.score} · ${t(WQI_BAND_KEY[wqi.band])}`}
        </Badge>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">{analysisText(reading, t)}</p>

      <div className="divide-y divide-border">
        {PARAM_ORDER.map((param) => (
          <QuickViewRow key={param} param={param} reading={reading} />
        ))}
      </div>
    </div>
  )
}
