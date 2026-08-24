/**
 * Capture form for a calibratable sensor. Turbidity uses 2 rows ("Standard
 * Input (NTU)" vs "Measured (raw ADC)"); TDS uses a single row (known ppm vs
 * an optional measured-ppm hint used only for the client-side k preview).
 * Submission is deferred to the parent's optimistic "Apply" mutation — this
 * component only collects values and lists/deletes already-saved points.
 *
 * Turbidity only also tracks the observed min/max of the live raw ADC while
 * this form is mounted (client-side, mirrors the old standalone /calibrate
 * page), with "Use min"/"Use max" buttons per row and a "Reset range" button.
 * TDS doesn't get this: its raw field is documented as an uncalibrated ppm
 * value, not the raw voltage `latestRaw` carries, so filling it from the
 * observed voltage range would insert the wrong kind of number.
 */
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useT } from '@/lib/i18n'
import { PARAM_META } from '@/lib/paramMeta'

export interface TwoPointFormPoint {
  reference: number
  raw?: number
  label?: string
}

export interface TwoPointFormSubmitRow {
  reference: number
  raw?: number
}

interface TwoPointFormProps {
  sensor: 'turbidity' | 'tds' | 'flow'
  pointCount: 1 | 2
  existingPoints: TwoPointFormPoint[]
  /** Live raw reading (ADC for turbidity, voltage for tds, pulse count for flow) shown as a hint. */
  latestRaw: number | null
  applying: boolean
  onApply: (rows: TwoPointFormSubmitRow[]) => void
  onDeletePoint: (index: number) => void
}

/** The calibration reference's unit -- a volume (liters) for flow, distinct from
 * PARAM_META.flow.unit ('L/min', a rate, used for the live reading elsewhere). */
const REFERENCE_UNIT: Record<'turbidity' | 'tds' | 'flow', string> = {
  turbidity: PARAM_META.turbidity.unit,
  tds: PARAM_META.tds.unit,
  flow: 'L',
}

export function TwoPointForm({
  sensor,
  pointCount,
  existingPoints,
  latestRaw,
  applying,
  onApply,
  onDeletePoint,
}: TwoPointFormProps) {
  const { t } = useT()
  const unit = REFERENCE_UNIT[sensor]
  const copy =
    sensor === 'turbidity'
      ? {
          title: t('calib.turbidityFormTitle'),
          referenceLabel: t('calib.turbidityReferenceLabel'),
          rawLabel: t('calib.turbidityRawLabel'),
          rawHint: t('calib.turbidityRawHint'),
        }
      : sensor === 'flow'
        ? {
            title: t('calib.flowFormTitle'),
            referenceLabel: t('calib.flowReferenceLabel'),
            rawLabel: t('calib.flowRawLabel'),
            rawHint: t('calib.flowRawHint'),
          }
        : {
            title: t('calib.tdsFormTitle'),
            referenceLabel: t('calib.tdsReferenceLabel'),
            rawLabel: t('calib.tdsRawLabel'),
            rawHint: t('calib.tdsRawHint'),
          }
  const [rows, setRows] = useState<{ reference: string; raw: string }[]>(
    Array.from({ length: pointCount }, () => ({ reference: '', raw: '' })),
  )

  const updateRow = (index: number, field: 'reference' | 'raw', value: string) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  // Observed raw-ADC range while this form is mounted, turbidity only (see file header).
  const trackRange = sensor === 'turbidity'
  const [observed, setObserved] = useState<{ min: number | null; max: number | null }>({
    min: null,
    max: null,
  })
  useEffect(() => {
    if (!trackRange || latestRaw == null) return
    setObserved((prev) => ({
      min: prev.min === null ? latestRaw : Math.min(prev.min, latestRaw),
      max: prev.max === null ? latestRaw : Math.max(prev.max, latestRaw),
    }))
  }, [trackRange, latestRaw])
  const resetRange = () => setObserved({ min: null, max: null })
  const useObserved = (index: number, which: 'min' | 'max') => {
    const value = observed[which]
    if (value == null) return
    updateRow(index, 'raw', String(Math.round(value)))
  }

  const canSubmit = rows.every((row) => row.reference.trim() !== '' && !Number.isNaN(Number(row.reference)))

  const handleApply = () => {
    if (!canSubmit) return
    onApply(
      rows.map((row) => ({
        reference: Number(row.reference),
        raw: row.raw.trim() === '' ? undefined : Number(row.raw),
      })),
    )
    setRows(Array.from({ length: pointCount }, () => ({ reference: '', raw: '' })))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{copy.title}</CardTitle>
        <CardDescription>
          {pointCount === 2 ? t('calib.needTwoPoints') : t('calib.singlePoint')}
          {latestRaw != null && (
            <>
              {' — '}
              {t('calib.liveReading')}:{' '}
              {sensor === 'tds' ? (
                <span className="font-mono">{latestRaw.toFixed(3)} V</span>
              ) : (
                <span className="font-mono">{latestRaw.toFixed(0)}</span>
              )}
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${sensor}-ref-${i}`}>
                {pointCount === 2 ? `${t('calib.pointLabel', { n: i + 1 })} — ` : ''}
                {copy.referenceLabel}
              </Label>
              <Input
                id={`${sensor}-ref-${i}`}
                type="number"
                inputMode="decimal"
                value={row.reference}
                onChange={(e) => updateRow(i, 'reference', e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${sensor}-raw-${i}`}>{copy.rawLabel}</Label>
              <Input
                id={`${sensor}-raw-${i}`}
                type="number"
                inputMode="decimal"
                value={row.raw}
                onChange={(e) => updateRow(i, 'raw', e.target.value)}
                placeholder={
                  sensor === 'turbidity' && latestRaw != null ? String(latestRaw) : ''
                }
              />
              <p className="text-xs text-muted-foreground">{copy.rawHint}</p>
              {trackRange && (
                <div className="flex gap-1.5 pt-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={observed.min == null}
                    onClick={() => useObserved(i, 'min')}
                  >
                    {t('calib.useMin')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={observed.max == null}
                    onClick={() => useObserved(i, 'max')}
                  >
                    {t('calib.useMax')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}

        {trackRange && (
          <div className="flex items-center justify-between gap-2 rounded-md bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
            <span>
              {t('calib.observedRange', {
                min: observed.min == null ? '—' : Math.round(observed.min),
                max: observed.max == null ? '—' : Math.round(observed.max),
              })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs"
              disabled={observed.min == null && observed.max == null}
              onClick={resetRange}
            >
              {t('calib.resetRange')}
            </Button>
          </div>
        )}

        <Button className="w-full sm:w-auto" disabled={!canSubmit || applying} onClick={handleApply}>
          {applying ? t('calib.applying') : t('calib.applyLabel')}
        </Button>

        {existingPoints.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground">{t('calib.savedPoints')}</p>
            <ul className="space-y-1.5">
              {existingPoints.map((point, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-2 rounded-md bg-secondary/50 px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {point.reference} {unit}
                    {point.raw != null ? ` — raw ${point.raw}` : ''}
                    {point.label ? ` (${point.label})` : ''}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => onDeletePoint(i)}
                    aria-label={t('calib.deletePoint')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
