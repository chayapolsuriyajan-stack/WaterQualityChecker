/**
 * Capture form for a calibratable sensor. Turbidity uses 2 rows ("Standard
 * Input (NTU)" vs "Measured (raw ADC)"); TDS uses a single row (known ppm vs
 * an optional measured-ppm hint used only for the client-side k preview).
 * Submission is deferred to the parent's optimistic "Apply" mutation — this
 * component only collects values and lists/deletes already-saved points.
 */
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

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
  sensor: 'turbidity' | 'tds'
  pointCount: 1 | 2
  existingPoints: TwoPointFormPoint[]
  /** Live raw reading (ADC for turbidity, voltage for tds) shown as a hint. */
  latestRaw: number | null
  applying: boolean
  onApply: (rows: TwoPointFormSubmitRow[]) => void
  onDeletePoint: (index: number) => void
}

const COPY = {
  turbidity: {
    title: 'สอบเทียบความขุ่น (2 จุด) / Turbidity calibration (2-point)',
    referenceLabel: 'ค่ามาตรฐาน (NTU) / Standard Input (NTU)',
    rawLabel: 'ค่าที่วัดได้ (Raw ADC) / Measured (raw ADC)',
    rawHint: 'เว้นว่างเพื่อใช้ค่าปัจจุบัน / leave blank to use the live reading',
    unit: 'NTU',
    applyLabel: 'ใช้ค่า / Apply',
  },
  tds: {
    title: 'สอบเทียบ TDS (k-factor) / TDS calibration (k-factor)',
    referenceLabel: 'ค่ามาตรฐาน (ppm) / Known ppm (reference)',
    rawLabel: 'ค่าที่วัดได้ (ppm) / Measured (ppm, optional)',
    rawHint:
      'ใช้เพื่อดูตัวอย่าง k เท่านั้น ไม่ถูกส่งไปเซิร์ฟเวอร์ — กรอกค่า ppm ที่ยังไม่ได้ปรับเทียบ (ไม่ใช่แรงดันไฟฟ้า) / preview only, not sent to the server — enter the uncalibrated ppm reading, not the raw voltage',
    unit: 'ppm',
    applyLabel: 'ใช้ค่า / Apply',
  },
} as const

export function TwoPointForm({
  sensor,
  pointCount,
  existingPoints,
  latestRaw,
  applying,
  onApply,
  onDeletePoint,
}: TwoPointFormProps) {
  const copy = COPY[sensor]
  const [rows, setRows] = useState<{ reference: string; raw: string }[]>(
    Array.from({ length: pointCount }, () => ({ reference: '', raw: '' })),
  )

  const updateRow = (index: number, field: 'reference' | 'raw', value: string) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
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
          {pointCount === 2 ? 'ต้องการ 2 จุด / needs 2 points' : 'จุดเดียว / single point'}
          {latestRaw != null && (
            <>
              {' — '}
              ค่าปัจจุบัน / live reading:{' '}
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
                {pointCount === 2 ? `จุดที่ ${i + 1} / Point ${i + 1} — ` : ''}
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
            </div>
          </div>
        ))}

        <Button className="w-full sm:w-auto" disabled={!canSubmit || applying} onClick={handleApply}>
          {applying ? 'กำลังบันทึก... / Applying...' : copy.applyLabel}
        </Button>

        {existingPoints.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground">จุดที่บันทึกแล้ว / Saved points</p>
            <ul className="space-y-1.5">
              {existingPoints.map((point, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-2 rounded-md bg-secondary/50 px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {point.reference} {copy.unit}
                    {point.raw != null ? ` — raw ${point.raw}` : ''}
                    {point.label ? ` (${point.label})` : ''}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => onDeletePoint(i)}
                    aria-label="Delete point / ลบจุด"
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
