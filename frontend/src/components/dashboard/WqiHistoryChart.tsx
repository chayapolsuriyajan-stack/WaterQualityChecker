/**
 * Top-of-dashboard WQI-over-time chart. Fetches /history for the selected
 * window, maps each row to a WQI score via wqiFromHistoryRow (frontend-derived,
 * shared logic with live readings), and draws it as a Recharts area/line with
 * two labeled reference lines at WQI 50 ("Moderate") and 70 ("Good").
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { getHistory } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { WQI_THRESHOLDS } from '@/lib/thresholds'
import { wqiFromHistoryRow } from '@/lib/wqi'
import type { HistoryWindow } from '@/lib/types'
import { WindowSelector } from './WindowSelector'

const SHORT_WINDOWS: HistoryWindow[] = ['5m', '15m', '1h']
const REFRESH_INTERVAL_MS = 10_000

function formatTime(ts: number, window: HistoryWindow): string {
  const d = new Date(ts)
  if (window === '3h' || window === '24h') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })
}

export function WqiHistoryChart() {
  const { t } = useT()
  const [window, setWindow] = useState<HistoryWindow>('15m')
  const isShort = SHORT_WINDOWS.includes(window)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['history', window],
    queryFn: () => getHistory(window),
    refetchInterval: isShort ? REFRESH_INTERVAL_MS : false,
  })

  const chartData = useMemo(() => {
    if (!data?.rows) return []
    return data.rows.map((row) => ({
      timestamp: row.timestamp,
      label: formatTime(row.timestamp, window),
      wqi: wqiFromHistoryRow(row).score,
    }))
  }, [data, window])

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">{t('wqi.title')}</CardTitle>
        <WindowSelector value={window} onChange={setWindow} />
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
                  <linearGradient id="wqi-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  minTickGap={24}
                  tickLine={false}
                />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} width={32} />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                />
                <ReferenceLine
                  y={WQI_THRESHOLDS.moderate}
                  stroke="#f59e0b"
                  strokeDasharray="4 4"
                  label={{ value: `${t('wqi.moderate')} (${WQI_THRESHOLDS.moderate})`, position: 'insideBottomLeft', fontSize: 11, fill: '#f59e0b' }}
                />
                <ReferenceLine
                  y={WQI_THRESHOLDS.good}
                  stroke="#22c55e"
                  strokeDasharray="4 4"
                  label={{ value: `${t('wqi.good')} (${WQI_THRESHOLDS.good})`, position: 'insideTopLeft', fontSize: 11, fill: '#22c55e' }}
                />
                <Area
                  type="monotone"
                  dataKey="wqi"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="url(#wqi-fill)"
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
