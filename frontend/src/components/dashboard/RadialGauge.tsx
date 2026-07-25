/**
 * Single radial "safety" gauge: current value as a % of the danger threshold,
 * rendered as a Recharts RadialBarChart ring, with both the live value and
 * the threshold number labeled on/near the gauge (hard requirement).
 */
import { RadialBar, RadialBarChart, PolarAngleAxis, ResponsiveContainer } from 'recharts'
import { colorFor, statusFor, type ThresholdParam } from '@/lib/thresholds'

interface RadialGaugeProps {
  labelTh: string
  labelEn: string
  value: number | null
  unit: string
  precision?: number
  param: ThresholdParam
  max: number
  thresholdWarn: number
  thresholdDanger: number
}

export function RadialGauge({
  labelTh,
  labelEn,
  value,
  unit,
  precision = 0,
  param,
  max,
  thresholdWarn,
  thresholdDanger,
}: RadialGaugeProps) {
  const safeValue = value ?? 0
  const pct = Math.min(100, Math.max(0, (safeValue / max) * 100))
  const color = value === null ? 'hsl(var(--muted-foreground))' : colorFor(param, value)
  const status = value === null ? null : statusFor(param, value)
  const warnPct = Math.min(100, (thresholdWarn / max) * 100)

  const data = [{ name: param, value: pct, fill: color }]

  // Threshold tick mark geometry, in a fixed 160x160 viewBox (cx=cy=80) that scales with the
  // container via the SVG's own viewBox regardless of actual rendered size. Matches the
  // RadialBarChart's innerRadius="72%"/outerRadius="100%" of the 80px half-extent.
  const tickAngleRad = ((90 - (warnPct / 100) * 360) * Math.PI) / 180
  const tickInner = 80 * 0.72
  const tickOuter = 80
  const tickX1 = 80 + tickInner * Math.cos(tickAngleRad)
  const tickY1 = 80 - tickInner * Math.sin(tickAngleRad)
  const tickX2 = 80 + tickOuter * Math.cos(tickAngleRad)
  const tickY2 = 80 - tickOuter * Math.sin(tickAngleRad)

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="relative h-40 w-40"
        role="img"
        aria-label={`${labelEn}: ${value === null ? 'no data' : `${safeValue.toFixed(precision)} ${unit}`}`}
      >
        <div aria-hidden="true" className="h-full w-full">
          <ResponsiveContainer width="100%" height="100%">
            <RadialBarChart
              cx="50%"
              cy="50%"
              innerRadius="72%"
              outerRadius="100%"
              barSize={12}
              data={data}
              startAngle={90}
              endAngle={-270}
            >
              <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
              <RadialBar background={{ fill: 'hsl(var(--muted))' }} dataKey="value" cornerRadius={8} isAnimationActive={false} />
            </RadialBarChart>
          </ResponsiveContainer>
          {/* Threshold tick mark on the ring at the warn % */}
          <svg viewBox="0 0 160 160" className="pointer-events-none absolute inset-0 h-full w-full">
            <line
              x1={tickX1}
              y1={tickY1}
              x2={tickX2}
              y2={tickY2}
              stroke="hsl(var(--foreground))"
              strokeOpacity={0.55}
              strokeWidth={2}
            />
          </svg>
        </div>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
          <div className="flex flex-col items-center">
            <span className="text-xl font-semibold tabular-nums" style={{ color }}>
              {value === null ? '—' : safeValue.toFixed(precision)}
            </span>
            <span className="text-[10px] text-muted-foreground">{unit}</span>
          </div>
        </div>
      </div>
      <div className="text-center">
        <p className="text-xs font-medium text-muted-foreground">
          {labelTh} <span className="opacity-70">/ {labelEn}</span>
        </p>
        <p className="text-[10px] text-muted-foreground">
          warn {thresholdWarn}
          {unit} · danger {thresholdDanger}
          {unit} (at {warnPct.toFixed(0)}% of scale)
        </p>
        {status && (
          <p className="text-[10px] font-medium" style={{ color }}>
            {status === 'good' ? 'Safe' : status === 'warn' ? 'Caution' : 'Danger'}
          </p>
        )}
      </div>
    </div>
  )
}
