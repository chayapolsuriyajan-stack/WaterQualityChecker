/**
 * Single radial "safety" gauge: current value as a % of the danger threshold,
 * rendered as a Recharts RadialBarChart ring, with both the live value and
 * the threshold number labeled on/near the gauge (hard requirement).
 */
import { RadialBar, RadialBarChart, PolarAngleAxis } from 'recharts'
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

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative h-36 w-36 sm:h-40 sm:w-40">
        <RadialBarChart
          width={160}
          height={160}
          cx="50%"
          cy="50%"
          innerRadius="72%"
          outerRadius="100%"
          barSize={12}
          data={data}
          startAngle={90}
          endAngle={-270}
          className="mx-auto"
        >
          <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
          <RadialBar background={{ fill: 'hsl(var(--muted))' }} dataKey="value" cornerRadius={8} isAnimationActive={false} />
        </RadialBarChart>
        {/* Threshold tick mark on the ring at the warn %, purely decorative label overlay */}
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          aria-hidden="true"
        >
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
