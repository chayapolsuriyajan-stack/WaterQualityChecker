/**
 * Parameter detail modal (picture 1): click a metric card to see a bigger
 * view with a chart (numbers + level lines), min/avg/max, a two-sided
 * warning, and About/Impact/Recommendation info cards. Impact + Recommendation
 * render only when the reading is out of range, per the approved decision —
 * keeps the modal compact when water is fine.
 *
 * Data source: TanStack `useQuery(['history', window])` — the SAME key shape
 * WqiHistoryChart uses, so the cache is shared instead of double-fetching.
 * `window` itself is lifted to DashboardView and passed in as a prop, so
 * every graph on the dashboard shares one global time-range control.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { getHistory } from '@/lib/api'
import { PARAM_META, type ParamKey } from '@/lib/paramMeta'
import { colorFor, normalRangeText, RANGE_BANDS, rangeStatusFor, type RangeParam, type Status } from '@/lib/thresholds'
import type { HistoryWindow } from '@/lib/types'
import { WindowChips } from './WindowChips'
import { DetailChart } from './DetailChart'
import { StatTiles } from './StatTiles'
import { RangeWarning } from './RangeWarning'

type CardStatus = Status | 'unknown'

const STATUS_BADGE_CLASS: Record<CardStatus, string> = {
  good: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-transparent',
  warn: 'bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))] border-transparent',
  danger: 'bg-destructive/15 text-destructive border-transparent',
  unknown: 'bg-muted text-muted-foreground border-transparent',
}

interface ParamDetailDialogProps {
  /** null = closed. */
  param: ParamKey | null
  onClose: () => void
  /** Current reading for this param. */
  liveValue: number | null
  /** Overrides meta.unit (turbidity may be 'ADC' when uncalibrated). */
  liveUnit?: string
  /** False for uncalibrated turbidity -> no scoring/threshold lines. */
  scorable?: boolean
  /** Shared history window -- see DashboardView. */
  window: HistoryWindow
  onWindowChange: (window: HistoryWindow) => void
  /** Selected station -- see DashboardView/StationSwitcher. */
  station: string
}

export function ParamDetailDialog({
  param,
  onClose,
  liveValue,
  liveUnit,
  scorable = true,
  window,
  onWindowChange,
  station,
}: ParamDetailDialogProps) {
  const { t } = useT()

  const meta = param ? PARAM_META[param] : null
  const unit = liveUnit ?? meta?.unit ?? ''

  const { data, isLoading, isError } = useQuery({
    queryKey: ['history', station, window],
    queryFn: () => getHistory(window, station),
    enabled: param !== null,
  })

  const chartRows = useMemo(() => {
    if (!meta || !data?.rows) return []
    return data.rows
      .map((row) => ({ timestamp: row.timestamp, value: row[meta.historyField] }))
      .filter(
        (p): p is { timestamp: number; value: number } =>
          typeof p.value === 'number' && Number.isFinite(p.value),
      )
  }, [data, meta])

  // Params with no RANGE_BANDS entry (e.g. flow) have no good/warn/danger judgment at all --
  // same "no score" path already used for an uncalibrated/unscorable reading.
  const rangeParam: RangeParam | null = param && param in RANGE_BANDS ? (param as RangeParam) : null
  const range = rangeParam && scorable && liveValue !== null ? rangeStatusFor(rangeParam, liveValue) : null
  const status: CardStatus = range ? range.status : 'unknown'
  const color = range && rangeParam ? colorFor(rangeParam, liveValue as number) : 'hsl(var(--muted-foreground))'
  const showImpactAndRecommendation =
    range !== null && range.direction !== 'ok' && meta?.impactKey !== undefined && meta?.recommendationKey !== undefined

  if (!param || !meta) {
    return null
  }

  const Icon = meta.icon
  const label = t(meta.labelKey)
  const fullName = meta.fullNameKey ? t(meta.fullNameKey) : null
  // Only show the unit full name when the rendered unit is actually meta's
  // calibrated unit -- e.g. uncalibrated turbidity overrides to raw "ADC" via
  // liveUnit, which has no meaningful NTU full name.
  const unitFullName = meta.unitFullNameKey && unit === meta.unit ? t(meta.unitFullNameKey) : null

  return (
    <Dialog open={param !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: `${color}22`, color }}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <DialogTitle>{label}</DialogTitle>
              {/* Spelled-out name for TDS/EC -- an acronym alone isn't self-explanatory
                  to a non-technical viewer. Omitted for params whose label is already
                  a plain word (temperature, turbidity). */}
              {fullName && <p className="text-xs text-muted-foreground">{fullName}</p>}
              {/* No normal-range text for params with no RANGE_BANDS entry (e.g. flow) --
                  there's no good/warn/danger band to describe. */}
              {rangeParam && (
                <DialogDescription>
                  {t('detail.normalRange', { range: normalRangeText(rangeParam) })}
                </DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Current value */}
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-secondary/40 p-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('detail.currentValue')}</p>
            {liveValue === null ? (
              <p className="mt-1 text-sm text-muted-foreground">{t('detail.noRecord')}</p>
            ) : (
              <p className="mt-1 text-2xl font-semibold tabular-nums" style={{ color }}>
                {liveValue.toFixed(meta.precision)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>
              </p>
            )}
            {/* Spelled-out unit name for abbreviations (NTU, ppm, µS/cm) that
                aren't self-explanatory to a non-technical viewer. Same
                subtext pattern as the param full name above. Omitted for
                temperature (°C) and for uncalibrated turbidity (raw ADC has
                no meaningful full name). */}
            {unitFullName && <p className="mt-0.5 text-xs text-muted-foreground">{unitFullName}</p>}
          </div>
          <Badge variant="outline" className={cn('shrink-0 whitespace-nowrap', STATUS_BADGE_CLASS[status])}>
            {t(
              status === 'good'
                ? 'status.good'
                : status === 'warn'
                  ? 'status.caution'
                  : status === 'danger'
                    ? 'status.danger'
                    : 'status.unknown',
            )}
          </Badge>
        </div>

        {/* Window selector */}
        <WindowChips value={window} onChange={onWindowChange} />

        {/* Chart */}
        <DetailChart
          param={param}
          rows={chartRows}
          unit={unit}
          precision={meta.precision}
          window={window}
          scorable={scorable}
          isLoading={isLoading}
          isError={isError}
        />

        {/* Stat tiles */}
        <StatTiles values={chartRows.map((r) => r.value)} unit={unit} precision={meta.precision} />

        {/* Range warning */}
        {range && rangeParam && liveValue !== null && (
          <RangeWarning
            param={rangeParam}
            paramLabel={label}
            value={liveValue}
            unit={unit}
            precision={meta.precision}
            range={range}
          />
        )}

        {/* Info cards */}
        <div className="space-y-3">
          <div className="flex gap-2 rounded-lg border border-border p-3 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div>
              <p className="font-medium">{t('detail.aboutTitle')}</p>
              <p className="mt-0.5 text-muted-foreground">{t(meta.aboutKey)}</p>
            </div>
          </div>
          {showImpactAndRecommendation && (
            <>
              <div className="flex gap-2 rounded-lg border border-border p-3 text-sm">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div>
                  <p className="font-medium">{t('detail.impactTitle')}</p>
                  {/* Non-null: showImpactAndRecommendation already checked both keys exist. */}
                  <p className="mt-0.5 text-muted-foreground">{t(meta.impactKey!)}</p>
                </div>
              </div>
              <div className="flex gap-2 rounded-lg border border-border p-3 text-sm">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div>
                  <p className="font-medium">{t('detail.recommendationTitle')}</p>
                  <p className="mt-0.5 text-muted-foreground">{t(meta.recommendationKey!)}</p>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
