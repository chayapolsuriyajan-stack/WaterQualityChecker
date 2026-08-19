import { useMemo, useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { statusFor, isSensorFault, type Status, type RangeParam } from '@/lib/thresholds'
import { useT } from '@/lib/i18n'
import type { MessageKey } from '@/lib/strings'
import type { HistoryRow } from '@/lib/types'

type SortKey = 'timestamp' | 'temperature' | 'turbidity' | 'tds' | 'ec'
type SortDir = 'asc' | 'desc'

interface Column {
  key: SortKey
  labelKey: MessageKey
}

const COLUMNS: Column[] = [
  { key: 'timestamp', labelKey: 'history.col.time' },
  { key: 'temperature', labelKey: 'history.col.temperature' },
  { key: 'turbidity', labelKey: 'history.col.turbidity' },
  { key: 'tds', labelKey: 'history.col.tds' },
  { key: 'ec', labelKey: 'history.col.ec' },
]

/** Format a possibly-null numeric value, or '—' when unavailable. */
function fmt(value: number | null | undefined, digits: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

/** A reading this close to zero is almost always a disconnected/faulty sensor, not real water data. */
type CellStatus = Status | 'fault'

/** statusFor requires a real number; returns null (unscorable) when the value is missing, or
 * 'fault' when the value looks like a disconnected sensor rather than a genuine reading. */
function statusForMaybe(param: RangeParam, value: number | null | undefined): CellStatus | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (isSensorFault(param, value)) return 'fault'
  return statusFor(param, value)
}

function statusBadge(status: CellStatus | null, t: (key: MessageKey) => string) {
  if (status == null) return null
  if (status === 'fault') {
    return (
      <Badge variant="secondary" className="ml-2 align-middle text-muted-foreground">
        {t('status.notConnected')}
      </Badge>
    )
  }
  const variant =
    status === 'good' ? 'secondary' : status === 'warn' ? 'default' : 'destructive'
  const label = status === 'good' ? t('status.good') : status === 'warn' ? t('status.caution') : t('status.danger')
  return (
    <Badge
      variant={variant}
      className={cn(
        'ml-2 align-middle',
        status === 'good' && 'bg-[hsl(var(--success))] text-[hsl(var(--success-foreground))]',
        status === 'warn' && 'bg-[hsl(var(--warning))] text-[hsl(var(--warning-foreground))]'
      )}
    >
      {label}
    </Badge>
  )
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function turbidityDisplay(row: HistoryRow): { value: string; status: CellStatus | null } {
  if (row.turbidityNtu != null) {
    const status = statusForMaybe('turbidity', row.turbidityNtu)
    return { value: `${fmt(row.turbidityNtu, 1)} NTU`, status }
  }
  if (row.turbidity != null) {
    return { value: `${fmt(row.turbidity, 0)} ADC`, status: 'good' }
  }
  return { value: '—', status: null }
}

function sortValue(row: HistoryRow, key: SortKey): number {
  // Missing values sort to the end regardless of direction.
  const raw = (() => {
    switch (key) {
      case 'timestamp':
        return row.timestamp
      case 'temperature':
        return row.temperature
      case 'turbidity':
        return row.turbidityNtu ?? row.turbidity
      case 'tds':
        return row.tds
      case 'ec':
        return row.ec
      default:
        return 0
    }
  })()
  return raw ?? Number.POSITIVE_INFINITY
}

export interface HistoryTableProps {
  rows: HistoryRow[]
}

export function HistoryTable({ rows }: HistoryTableProps) {
  const { t } = useT()
  const [sortKey, setSortKey] = useState<SortKey>('timestamp')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => {
      const av = sortValue(a, sortKey)
      const bv = sortValue(b, sortKey)
      return sortDir === 'asc' ? av - bv : bv - av
    })
    return copy
  }, [rows, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card/70 p-8 text-center text-sm text-muted-foreground backdrop-blur-md">
        {t('history.empty')}
      </div>
    )
  }

  return (
    <>
      {/* Phone: stacked cards, no horizontal overflow */}
      <div className="flex flex-col gap-3 md:hidden">
        {sorted.map((row, i) => {
          const turb = turbidityDisplay(row)
          const tempStatus = statusForMaybe('temperature', row.temperature)
          const tdsStatus = statusForMaybe('tds', row.tds)
          const ecStatus = statusForMaybe('ec', row.ec)
          return (
            <div
              key={`${row.timestamp}-${i}`}
              className="rounded-lg border border-border bg-card/70 p-4 shadow-sm backdrop-blur-md"
            >
              <div className="mb-2 text-sm font-semibold text-foreground">
                {formatTime(row.timestamp)}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('param.temperature.label')}</dt>
                <dd className="text-right">
                  {fmt(row.temperature, 1)} °C {statusBadge(tempStatus, t)}
                </dd>
                <dt className="text-muted-foreground">{t('param.turbidity.label')}</dt>
                <dd className="text-right">
                  {turb.value} {statusBadge(turb.status, t)}
                </dd>
                <dt className="text-muted-foreground">{t('param.tds.label')}</dt>
                <dd className="text-right">
                  {fmt(row.tds, 0)} ppm {statusBadge(tdsStatus, t)}
                </dd>
                <dt className="text-muted-foreground">{t('param.ec.label')}</dt>
                <dd className="text-right">
                  {fmt(row.ec, 0)} µS/cm {statusBadge(ecStatus, t)}
                </dd>
              </dl>
            </div>
          )
        })}
      </div>

      {/* Tablet/desktop: scrollable table */}
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((col) => (
                <TableHead key={col.key} className="whitespace-nowrap p-0">
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className="flex min-h-11 w-full items-center gap-1 px-3 py-2 text-left font-medium hover:text-foreground"
                  >
                    <span className="flex flex-col leading-tight">
                      <span>{t(col.labelKey)}</span>
                    </span>
                    {sortKey === col.key && (
                      <span aria-hidden className="text-xs">
                        {sortDir === 'asc' ? '▲' : '▼'}
                      </span>
                    )}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row, i) => {
              const turb = turbidityDisplay(row)
              const tempStatus = statusForMaybe('temperature', row.temperature)
              const tdsStatus = statusForMaybe('tds', row.tds)
              const ecStatus = statusForMaybe('ec', row.ec)
              return (
                <TableRow key={`${row.timestamp}-${i}`}>
                  <TableCell className="whitespace-nowrap">{formatTime(row.timestamp)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {fmt(row.temperature, 1)} °C {statusBadge(tempStatus, t)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {turb.value} {statusBadge(turb.status, t)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {fmt(row.tds, 0)} {statusBadge(tdsStatus, t)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {fmt(row.ec, 0)} {statusBadge(ecStatus, t)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </>
  )
}
