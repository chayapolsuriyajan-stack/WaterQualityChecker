import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { getHistory } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/strings'
import type { HistoryRow, HistoryWindow } from '@/lib/types'
import { HistoryTable } from './HistoryTable'

const WINDOWS: { value: HistoryWindow; labelKey: MessageKey }[] = [
  { value: '5m', labelKey: 'window.5m' },
  { value: '15m', labelKey: 'window.15m' },
  { value: '1h', labelKey: 'window.1h' },
  { value: '3h', labelKey: 'window.3h' },
  { value: '12h', labelKey: 'window.12h' },
  { value: '24h', labelKey: 'window.24h' },
]

const LIVE_WINDOWS: HistoryWindow[] = ['5m', '15m', '1h']
const REFETCH_MS = 15_000

function csvEscape(value: string | number | null): string {
  if (value == null) return ''
  const s = String(value)
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function buildCsv(rows: HistoryRow[]): string {
  const header = [
    'Timestamp (ISO)',
    'Temperature (C)',
    'Turbidity',
    'Turbidity Unit',
    'TDS (ppm)',
    'EC (uS/cm)',
  ]
  const lines = [header.map(csvEscape).join(',')]
  for (const row of rows) {
    const turbidity = row.turbidityNtu != null ? row.turbidityNtu : row.turbidity
    const turbidityUnit = row.turbidityNtu != null ? 'NTU' : 'ADC'
    lines.push(
      [
        new Date(row.timestamp).toISOString(),
        row.temperature,
        turbidity,
        turbidityUnit,
        row.tds,
        row.ec,
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return lines.join('\n')
}

function downloadCsv(rows: HistoryRow[], window: HistoryWindow) {
  const csv = buildCsv(rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `aqua-monitor-history-${window}-${Date.now()}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function HistoryView() {
  const { t } = useT()
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>('15m')

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ['history-table', historyWindow],
    queryFn: () => getHistory(historyWindow),
    refetchInterval: LIVE_WINDOWS.includes(historyWindow) ? REFETCH_MS : false,
  })

  const rows = data?.rows ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t('history.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {isLoading
              ? t('history.loading')
              : isError
                ? t('history.failed')
                : `${t('history.rowCount', { count: rows.length, source: data?.source ?? '—' })}${
                    isFetching ? ` · ${t('history.refreshing')}` : ''
                  }`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t('window.label')}
            className="flex flex-wrap gap-1 rounded-lg border border-border bg-card/70 p-1 backdrop-blur-md"
          >
            {WINDOWS.map((w) => (
              <button
                key={w.value}
                type="button"
                onClick={() => setHistoryWindow(w.value)}
                className={cn(
                  'min-h-11 rounded-md px-3 text-sm font-medium transition-colors',
                  historyWindow === w.value
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                {t(w.labelKey)}
              </button>
            ))}
          </div>

          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={rows.length === 0}
            onClick={() => downloadCsv(rows, historyWindow)}
          >
            <Download className="size-4" />
            {t('history.exportCsv')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <HistoryTable rows={rows} />
      )}
    </div>
  )
}
