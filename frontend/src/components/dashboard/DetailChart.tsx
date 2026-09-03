/**
 * Recharts area chart for the parameter detail modal: gradient fill, numeric
 * value labels on data points (auto-thinned on dense windows so a 400-point
 * 24h window doesn't turn into unreadable mush), and labeled ReferenceLines
 * for that param's caution/danger cut-offs from RANGE_BANDS (both sides where
 * a low band exists — turbidity is upper-only). Threshold lines are suppressed
 * entirely when `scorable` is false (e.g. uncalibrated turbidity).
 */
import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { useT } from '@/lib/i18n'
import type { ParamKey } from '@/lib/paramMeta'
import { RANGE_BANDS, STATUS_COLOR, type RangeParam } from '@/lib/thresholds'
import type { HistoryWindow } from '@/lib/types'

function isRangeParam(param: ParamKey): param is RangeParam {
  return param in RANGE_BANDS
}

const LONG_WINDOWS: HistoryWindow[] = ['3h', '12h', '24h']
/** Cap on visible point labels — beyond this we thin to every Nth point (plus first/last). */
const MAX_LABELS = 8

function formatTime(ts: number, window: HistoryWindow): string {
  const d = new Date(ts)
  if (LONG_WINDOWS.includes(window)) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface ChartPoint {
  timestamp: number
  value: number
}

interface DetailChartProps {
  /** Params with no RANGE_BANDS entry (e.g. flow) render with no threshold lines/Y-domain
   * clamping, same code path as `scorable={false}` for an uncalibrated param. */
  param: ParamKey
  rows: ChartPoint[]
  unit: string
  precision: number
  window: HistoryWindow
  scorable?: boolean
  isLoading?: boolean
  isError?: boolean
}

export function DetailChart({
  param,
  rows,
  unit,
  precision,
  window,
  scorable = true,
  isLoading = false,
  isError = false,
}: DetailChartProps) {
  const { t } = useT()
  const band = isRangeParam(param) ? RANGE_BANDS[param] : undefined

  const chartData = useMemo(
    () => rows.map((r) => ({ ...r, label: formatTime(r.timestamp, window) })),
    [rows, window],
  )

  // Thin point labels: always show first/last, plus an even spread capped at MAX_LABELS.
  const labeledIndices = useMemo(() => {
    const n = chartData.length
    if (n === 0) return new Set<number>()
    if (n <= MAX_LABELS) return new Set(chartData.map((_, i) => i))
    const step = Math.ceil(n / MAX_LABELS)
    const set = new Set<number>()
    for (let i = 0; i < n; i += step) set.add(i)
    set.add(n - 1)
    return set
  }, [chartData])

  const gradientId = `detail-fill-${param}`

  /**
   * Y domain that keeps the *nearest* threshold line visible on each side of the
   * data. Recharts' default domain is data-driven, so a limit outside the data
   * range gets clipped and the reader can't see how close they are to it. We
   * deliberately include only the closest line above and below (not every band),
   * because pulling a far-away limit into view flattens the trend to a straight
   * line and hides the variation the chart exists to show.
   */
  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (!scorable || !band) return undefined
    const values = chartData
      .map((r) => r.value)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (values.length === 0) return undefined

    const lines = [band.goodMin, band.goodMax, band.dangerMin, band.dangerMax].filter(
      (v): v is number => typeof v === 'number',
    )
    const dataMin = Math.min(...values)
    const dataMax = Math.max(...values)

    const below = lines.filter((v) => v <= dataMin)
    const above = lines.filter((v) => v >= dataMax)
    let lo = below.length > 0 ? Math.max(...below) : dataMin
    let hi = above.length > 0 ? Math.min(...above) : dataMax

    const pad = (hi - lo) * 0.08 || Math.max(Math.abs(hi) * 0.05, 1)
    lo -= pad
    hi += pad
    return [Math.floor(lo), Math.ceil(hi)]
  }, [chartData, band, scorable])

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />
  }

  if (isError) {
    return <p className="text-sm text-destructive">{t('wqi.error')}</p>
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('wqi.empty')}</p>
  }

  return (
    <div className="space-y-1">
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 20, right: 16, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} width={40} domain={yDomain ?? ['auto', 'auto']} allowDataOverflow={false} />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: 'hsl(var(--foreground))' }}
              formatter={(value) => [`${Number(value).toFixed(precision)} ${unit}`, undefined]}
              labelFormatter={(_, payload) => {
                const ts = payload?.[0]?.payload?.timestamp
                return typeof ts === 'number' ? new Date(ts).toLocaleString() : ''
              }}
            />
            {scorable && band && band.goodMax != null && (
              <ReferenceLine
                y={band.goodMax}
                stroke={STATUS_COLOR.warn}
                strokeDasharray="4 4"
                label={{
                  value: `${t('status.caution')} ${band.goodMax}${unit}`,
                  position: 'insideTopLeft',
                  fontSize: 10,
                  fill: STATUS_COLOR.warn,
                }}
              />
            )}
            {scorable && band && band.dangerMax != null && (
              <ReferenceLine
                y={band.dangerMax}
                stroke={STATUS_COLOR.danger}
                strokeDasharray="4 4"
                label={{
                  value: `${t('status.danger')} ${band.dangerMax}${unit}`,
                  position: 'insideTopLeft',
                  fontSize: 10,
                  fill: STATUS_COLOR.danger,
                }}
              />
            )}
            {scorable && band && band.goodMin != null && (
              <ReferenceLine
                y={band.goodMin}
                stroke={STATUS_COLOR.warn}
                strokeDasharray="4 4"
                label={{
                  value: `${t('status.caution')} ${band.goodMin}${unit}`,
                  position: 'insideBottomLeft',
                  fontSize: 10,
                  fill: STATUS_COLOR.warn,
                }}
              />
            )}
            {scorable && band && band.dangerMin != null && (
              <ReferenceLine
                y={band.dangerMin}
                stroke={STATUS_COLOR.danger}
                strokeDasharray="4 4"
                label={{
                  value: `${t('status.danger')} ${band.dangerMin}${unit}`,
                  position: 'insideBottomLeft',
                  fontSize: 10,
                  fill: STATUS_COLOR.danger,
                }}
              />
            )}
            <Area
              type="monotone"
              dataKey="value"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="value"
                content={(props: unknown) => {
                  const { x, y, index, value } = props as {
                    x?: number
                    y?: number
                    index?: number
                    value?: number
                  }
                  if (
                    index === undefined ||
                    !labeledIndices.has(index) ||
                    x === undefined ||
                    y === undefined ||
                    typeof value !== 'number'
                  ) {
                    return null
                  }
                  return (
                    <text x={x} y={y - 8} textAnchor="middle" fontSize={10} fill="hsl(var(--foreground))">
                      {value.toFixed(precision)}
                    </text>
                  )
                }}
              />
            </Area>
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('detail.dataPoints', { count: rows.length })} · {t('detail.chartCaption')}
      </p>
    </div>
  )
}
