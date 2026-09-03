/**
 * Compact per-parameter sparkline for a ParamCard. Draws the last ~30s of
 * samples plus a single labeled threshold reference line (the "warn" band
 * edge from lib/thresholds.ts) so every chart on the dashboard — down to the
 * smallest one — carries a visible numeric threshold.
 */
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, YAxis } from 'recharts'
import type { SeriesPoint } from '@/lib/useSensorSocket'

interface SparklineProps {
  data: SeriesPoint[]
  color: string
  threshold: number
  thresholdLabel: string
  /** Draw the threshold reference line. Set false when the series isn't scorable against it. */
  showThreshold?: boolean
  height?: number
}

export function Sparkline({
  data,
  color,
  threshold,
  thresholdLabel,
  showThreshold = true,
  height = 56,
}: SparklineProps) {
  const values = data.map((p) => p.v)
  const domainMax = showThreshold ? Math.max(threshold * 1.15, ...values, 1) : Math.max(...values, 1)
  const domainMin = Math.min(0, ...values)

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <defs>
            <linearGradient id={`spark-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={[domainMin, domainMax]} hide />
          {showThreshold && (
            <ReferenceLine
              y={threshold}
              stroke="currentColor"
              strokeOpacity={0.45}
              strokeDasharray="3 3"
              label={{
                value: thresholdLabel,
                position: 'insideTopRight',
                fontSize: 9,
                fill: 'currentColor',
                opacity: 0.6,
              }}
            />
          )}
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            fill={`url(#spark-${color.replace('#', '')})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
