/**
 * One live metric card in the ParamGrid: i18n label, live value, status
 * badge/color from lib/thresholds.ts, and an embedded Sparkline (with its own
 * labeled threshold line) built from the rolling ~30s series. Genuinely
 * interactive — click, Enter, or Space opens the parameter detail modal.
 */
import type { KeyboardEvent } from 'react'
import { motion } from 'motion/react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/strings'
import { colorFor, statusFor, type Status, type ThresholdParam } from '@/lib/thresholds'
import type { SeriesPoint } from '@/lib/useSensorSocket'
import { Sparkline } from './Sparkline'

type CardStatus = Status | 'unknown'

const STATUS_KEY: Record<CardStatus, MessageKey> = {
  good: 'status.good',
  warn: 'status.caution',
  danger: 'status.danger',
  unknown: 'status.unknown',
}

const STATUS_BADGE_CLASS: Record<CardStatus, string> = {
  good: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-transparent',
  warn: 'bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))] border-transparent',
  danger: 'bg-destructive/15 text-destructive border-transparent',
  unknown: 'bg-muted text-muted-foreground border-transparent',
}

interface ParamCardProps {
  labelKey: MessageKey
  value: number | null
  unit: string
  /** Spelled-out name of `unit` (e.g. "Nephelometric Turbidity Units" for
   * NTU), shown as a hover title on the unit text. Omitted for units that
   * are self-explanatory (°C) or not meaningfully nameable (raw ADC). */
  unitFullNameKey?: MessageKey
  precision?: number
  /** Omit when the value can't be scored against a threshold (e.g. uncalibrated raw ADC). */
  param?: ThresholdParam
  threshold: number
  thresholdLabel: string
  /** Whether the sparkline should draw its threshold reference line. Defaults to true. */
  showThreshold?: boolean
  /** Optional hint shown under the value, e.g. for an unscorable/uncalibrated reading. */
  hint?: string
  series: SeriesPoint[]
  index?: number
  onOpen: () => void
}

export function ParamCard({
  labelKey,
  value,
  unit,
  unitFullNameKey,
  precision = 1,
  param,
  threshold,
  thresholdLabel,
  showThreshold = true,
  hint,
  series,
  index = 0,
  onOpen,
}: ParamCardProps) {
  const { t } = useT()
  const status: CardStatus = value === null || param === undefined ? 'unknown' : statusFor(param, value)
  const color = status === 'unknown' ? 'hsl(var(--muted-foreground))' : colorFor(param!, value!)

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen()
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05, ease: 'easeOut' }}
      className="motion-reduce:transition-none"
    >
      <Card
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={handleKeyDown}
        aria-label={t(labelKey)}
        className="cursor-pointer overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-muted-foreground">{t(labelKey)}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums" style={{ color }}>
                {value === null ? '—' : value.toFixed(precision)}
                <span
                  className="ml-1 text-sm font-normal text-muted-foreground"
                  title={unitFullNameKey ? t(unitFullNameKey) : undefined}
                >
                  {unit}
                </span>
              </p>
              {hint && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p>}
            </div>
            <Badge variant="outline" className={cn('shrink-0 whitespace-nowrap', STATUS_BADGE_CLASS[status])}>
              {t(STATUS_KEY[status])}
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
