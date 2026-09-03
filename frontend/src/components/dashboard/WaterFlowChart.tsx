/**
 * Live "Water Flow" chart: mirrors WqiHistoryChart's structure/cache key (same
 * useQuery(['history', window]) so the fetch is shared with every other history-driven
 * chart), plotting flowRate instead of computed WQI. Short windows already return
 * per-reading (~2s) resolution from /history, so this satisfies the "every 2 seconds" live
 * granularity with no extra backend work. Renders nothing when hidden via Settings.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { getHistory } from '@/lib/api'
import { useDashboardPrefs } from '@/lib/DashboardPrefsProvider'
import { useT } from '@/lib/i18n'
import type { HistoryWindow } from '@/lib/types'
import { WindowSelector } from './WindowSelector'

const SHORT_WINDOWS: HistoryWindow[] = ['5m', '15m', '1h']
const REFRESH_INTERVAL_MS = 10_000

function formatTime(ts: number, window: HistoryWindow): string {
  const d = new Date(ts)
  if (window === '3h' || window === '24h') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface WaterFlowChartProps {
  /** Shared with every other graph on the dashboard -- see DashboardView. */
  window: HistoryWindow
  onWindowChange: (window: HistoryWindow) => void
  /** Selected station -- see DashboardView/StationSwitcher. */
  station: string
}

export function WaterFlowChart({ window, onWindowChange, station }: WaterFlowChartProps) {
  const { t } = useT()
  const { visible } = useDashboardPrefs()
  const isShort = SHORT_WINDOWS.includes(window)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['history', station, window],
    queryFn: () => getHistory(window, station),
    refetchInterval: isShort ? REFRESH_INTERVAL_MS : false,
    enabled: visible.flow,
  })

  const chartData = useMemo(() => {
    if (!data?.rows) return []
    return data.rows
      .filter((row) => typeof row.flowRate === 'number')
      .map((row) => ({
        timestamp: row.timestamp,
        label: formatTime(row.timestamp, window),
        flowRate: row.flowRate,
      }))
  }, [data, window])

  if (!visible.flow) return null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">{t('chart.flow.title')}</CardTitle>
        <WindowSelector value={window} onChange={onWindowChange} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">{t('wqi.error')}</p>
        ) : chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('wqi.empty')}</p>
        ) : (
          <div className="h-56 w-full sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id="flow-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} width={40} />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                  formatter={(value) => [`${Number(value).toFixed(1)} ${t('chart.flow.unit')}`, undefined]}
                  labelFormatter={(_, payload) => {
                    const ts = payload?.[0]?.payload?.timestamp
                    return typeof ts === 'number' ? new Date(ts).toLocaleString() : ''
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="flowRate"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="url(#flow-fill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
