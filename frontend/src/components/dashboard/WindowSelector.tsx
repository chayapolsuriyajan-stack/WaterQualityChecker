/**
 * History window selector for WqiHistoryChart: 5m/15m/1h/3h/24h.
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { HistoryWindow } from '@/lib/types'

const WINDOW_LABELS: Record<HistoryWindow, string> = {
  '5m': '5 min',
  '15m': '15 min',
  '1h': '1 hour',
  '3h': '3 hours',
  '24h': '24 hours',
}

const WINDOWS: HistoryWindow[] = ['5m', '15m', '1h', '3h', '24h']

interface WindowSelectorProps {
  value: HistoryWindow
  onChange: (window: HistoryWindow) => void
}

export function WindowSelector({ value, onChange }: WindowSelectorProps) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as HistoryWindow)}>
      <SelectTrigger className="w-[110px]" aria-label="History window">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {WINDOWS.map((w) => (
          <SelectItem key={w} value={w}>
            {WINDOW_LABELS[w]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
