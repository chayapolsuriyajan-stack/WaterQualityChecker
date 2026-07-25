/**
 * Min / avg / max tiles for the parameter detail modal, computed from the
 * fetched window's rows (not the backend's sensor_stats — see ParamDetailDialog
 * header comment for why: no `ec`, no average, and since-server-start rather
 * than per-window).
 */
import { useT } from '@/lib/i18n'

interface StatTilesProps {
  values: number[]
  unit: string
  precision: number
}

function fmt(n: number | null, precision: number): string {
  return n === null ? '—' : n.toFixed(precision)
}

export function StatTiles({ values, unit, precision }: StatTilesProps) {
  const { t } = useT()

  const finite = values.filter((v) => Number.isFinite(v))
  const min = finite.length ? Math.min(...finite) : null
  const max = finite.length ? Math.max(...finite) : null
  const avg = finite.length ? finite.reduce((sum, v) => sum + v, 0) / finite.length : null

  const tiles: Array<{ key: string; label: string; value: number | null }> = [
    { key: 'min', label: t('detail.min'), value: min },
    { key: 'avg', label: t('detail.avg'), value: avg },
    { key: 'max', label: t('detail.max'), value: max },
  ]

  return (
    <div className="grid grid-cols-3 gap-2">
      {tiles.map((tile) => (
        <div key={tile.key} className="rounded-lg border border-border bg-secondary/40 p-3 text-center">
          <p className="text-[11px] font-medium text-muted-foreground">{tile.label}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {fmt(tile.value, precision)}
            {tile.value !== null && <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>}
          </p>
        </div>
      ))}
    </div>
  )
}
