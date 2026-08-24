/**
 * "Water Usage" chart: one bar per calendar day from GET /flow/usage (storage.py's
 * daily_usage table -- a different shape/cadence than the per-reading /history endpoint,
 * see storage.py's docstring), no window selector since it's inherently daily-bucketed.
 * Renders nothing when hidden via Settings.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { getFlowUsage, resetFlowUsageToday } from '@/lib/api'
import { useDashboardPrefs } from '@/lib/DashboardPrefsProvider'
import { useT } from '@/lib/i18n'

const DAYS = 14
const REFRESH_INTERVAL_MS = 30_000

function formatDay(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function WaterUsageChart() {
  const { t } = useT()
  const { visible } = useDashboardPrefs()
  const queryClient = useQueryClient()
  const [resetting, setResetting] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['flow-usage', DAYS],
    queryFn: () => getFlowUsage(DAYS),
    refetchInterval: REFRESH_INTERVAL_MS,
    enabled: visible.waterUsage,
  })

  const chartData = (data?.days ?? []).map((row) => ({
    date: row.date,
    label: formatDay(row.date),
    totalLiters: row.totalLiters,
  }))

  const handleResetToday = async () => {
    setResetting(true)
    try {
      await resetFlowUsageToday()
      toast.success(t('chart.usage.resetSuccess'))
      await queryClient.invalidateQueries({ queryKey: ['flow-usage', DAYS] })
    } catch {
      toast.error(t('chart.usage.resetFailed'))
    } finally {
      setResetting(false)
    }
  }

  if (!visible.waterUsage) return null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">{t('chart.usage.title')}</CardTitle>
          {data && (
            <p className="text-xs text-muted-foreground">
              {t('chart.usage.today', { value: data.today.toFixed(1) })}
            </p>
          )}
        </div>
        <Button type="button" variant="outline" size="sm" disabled={resetting} onClick={() => void handleResetToday()}>
          {t('chart.usage.resetToday')}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">{t('wqi.error')}</p>
        ) : chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('chart.usage.empty')}</p>
        ) : (
          <div className="h-56 w-full sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={16} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} width={40} />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                  formatter={(value) => [`${Number(value).toFixed(1)} ${t('chart.usage.unit')}`, undefined]}
                />
                <Bar dataKey="totalLiters" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
