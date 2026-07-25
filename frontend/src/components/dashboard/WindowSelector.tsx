/**
 * History window selector for WqiHistoryChart: 5m/15m/1h/3h/12h/24h.
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/strings'
import type { HistoryWindow } from '@/lib/types'

const WINDOW_KEYS: Record<HistoryWindow, MessageKey> = {
  '5m': 'window.5m',
  '15m': 'window.15m',
  '1h': 'window.1h',
  '3h': 'window.3h',
  '12h': 'window.12h',
  '24h': 'window.24h',
}

const WINDOWS: HistoryWindow[] = ['5m', '15m', '1h', '3h', '12h', '24h']

interface WindowSelectorProps {
  value: HistoryWindow
  onChange: (window: HistoryWindow) => void
}

export function WindowSelector({ value, onChange }: WindowSelectorProps) {
  const { t } = useT()
  return (
    <Select value={value} onValueChange={(v) => onChange(v as HistoryWindow)}>
      <SelectTrigger className="w-[110px]" aria-label={t('window.label')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {WINDOWS.map((w) => (
          <SelectItem key={w} value={w}>
            {t(WINDOW_KEYS[w])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
