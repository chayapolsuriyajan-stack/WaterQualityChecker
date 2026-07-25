/**
 * Pill/chip row for selecting a history window inside the parameter detail
 * modal. Covers all 6 windows (5m/15m/1h/3h/12h/24h) — unlike WindowSelector's
 * dropdown, this is a set of real, always-visible buttons per picture 1/2.
 */
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/strings'
import type { HistoryWindow } from '@/lib/types'

const WINDOWS: HistoryWindow[] = ['5m', '15m', '1h', '3h', '12h', '24h']

const WINDOW_KEYS: Record<HistoryWindow, MessageKey> = {
  '5m': 'window.5m',
  '15m': 'window.15m',
  '1h': 'window.1h',
  '3h': 'window.3h',
  '12h': 'window.12h',
  '24h': 'window.24h',
}

interface WindowChipsProps {
  value: HistoryWindow
  onChange: (window: HistoryWindow) => void
}

export function WindowChips({ value, onChange }: WindowChipsProps) {
  const { t } = useT()

  return (
    <div role="group" aria-label={t('window.label')} className="flex flex-wrap gap-2">
      {WINDOWS.map((w) => {
        const active = w === value
        return (
          <button
            key={w}
            type="button"
            onClick={() => onChange(w)}
            aria-pressed={active}
            className={cn(
              'min-h-[44px] min-w-[44px] rounded-full border px-3 py-2 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              active
                ? 'border-transparent bg-primary text-primary-foreground shadow'
                : 'border-border bg-secondary text-secondary-foreground hover:bg-secondary/80',
            )}
          >
            {t(WINDOW_KEYS[w])}
          </button>
        )
      })}
    </div>
  )
}
