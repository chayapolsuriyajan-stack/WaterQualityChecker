/**
 * One live metric card in the ParamGrid: bilingual label, live value, status
 * badge/color from lib/thresholds.ts, and an embedded Sparkline (with its own
 * labeled threshold line) built from the rolling ~30s series.
 */
import { motion } from 'motion/react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { colorFor, statusFor, type Status, type ThresholdParam } from '@/lib/thresholds'
import type { SeriesPoint } from '@/lib/useSensorSocket'
import { Sparkline } from './Sparkline'

type CardStatus = Status | 'unknown'

const STATUS_LABEL: Record<CardStatus, string> = {
  good: 'Good',
  warn: 'Caution',
  danger: 'Danger',
  unknown: '—',
}

const STATUS_BADGE_CLASS: Record<CardStatus, string> = {
  good: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-transparent',
  warn: 'bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))] border-transparent',
  danger: 'bg-destructive/15 text-destructive border-transparent',
  unknown: 'bg-muted text-muted-foreground border-transparent',
}

interface ParamCardProps {
  labelTh: string
  labelEn: string
  value: number | null
  unit: string
  precision?: number
  /** Omit when the value can't be scored against a threshold (e.g. uncalibrated raw ADC). */
  param?: ThresholdParam
  threshold: number
  thresholdLabel: string
  /** Whether the sparkline should draw its threshold reference line. Defaults to true. */
  showThreshold?: boolean
  /** Optional bilingual hint shown under the value, e.g. for an unscorable/uncalibrated reading. */
  hint?: string
  series: SeriesPoint[]
  index?: number
}

export function ParamCard({
  labelTh,
  labelEn,
  value,
  unit,
  precision = 1,
  param,
  threshold,
  thresholdLabel,
  showThreshold = true,
  hint,
  series,
  index = 0,
}: ParamCardProps) {
  const status: CardStatus = value === null || param === undefined ? 'unknown' : statusFor(param, value)
  const color = status === 'unknown' ? 'hsl(var(--muted-foreground))' : colorFor(param!, value!)

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05, ease: 'easeOut' }}
      className="motion-reduce:transition-none"
    >
      <Card className="overflow-hidden transition-shadow hover:shadow-md">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-muted-foreground">
                {labelTh} <span className="opacity-70">/ {labelEn}</span>
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums" style={{ color }}>
                {value === null ? '—' : value.toFixed(precision)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>
              </p>
              {hint && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p>}
            </div>
            <Badge variant="outline" className={cn('shrink-0 whitespace-nowrap', STATUS_BADGE_CLASS[status])}>
              {STATUS_LABEL[status]}
            </Badge>
          </div>
          <div className="mt-3">
            <Sparkline
              data={series}
              color={color}
              threshold={threshold}
              thresholdLabel={thresholdLabel}
              showThreshold={showThreshold}
            />
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
