/**
 * Live read-out of the current (or optimistically predicted) coefficients for
 * a calibratable sensor, plus the resulting calibrated value for the latest
 * raw reading. Shared shape for turbidity (linear2: slope/intercept) and tds
 * (kfactor: k).
 */
import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export type TurbidityCoefficients = { slope: number; intercept: number }
export type TdsCoefficients = { k: number }

interface CoefficientPreviewProps {
  sensor: 'turbidity' | 'tds'
  coefficients: TurbidityCoefficients | TdsCoefficients | null
  /** Live raw reading: ADC for turbidity, voltage for tds. */
  latestRaw: number | null
  /** True while an optimistic (unconfirmed) prediction is showing. */
  pending?: boolean
  updated?: string | null
  className?: string
}

function isTurbidity(
  sensor: 'turbidity' | 'tds',
  _coefficients: TurbidityCoefficients | TdsCoefficients,
): _coefficients is TurbidityCoefficients {
  return sensor === 'turbidity'
}

export function CoefficientPreview({
  sensor,
  coefficients,
  latestRaw,
  pending = false,
  updated,
  className,
}: CoefficientPreviewProps) {
  return (
    <Card className={cn(className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">ค่าสัมประสิทธิ์ / Coefficients</CardTitle>
        {pending && (
          <Badge variant="outline" className="border-warning/50 text-warning">
            กำลังยืนยัน... / pending
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!coefficients ? (
          <p className="text-sm text-muted-foreground">
            ยังไม่ได้สอบเทียบ / not yet calibrated — ต้องการอย่างน้อย{' '}
            {sensor === 'turbidity' ? '2 จุด / 2 points' : '1 จุด / 1 point'}
          </p>
        ) : isTurbidity(sensor, coefficients) ? (
          <>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">slope</dt>
                <dd className="font-mono text-base">{coefficients.slope.toFixed(5)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">intercept</dt>
                <dd className="font-mono text-base">{coefficients.intercept.toFixed(3)}</dd>
              </div>
            </dl>
            {latestRaw != null && (
              <p className="text-sm">
                ผลลัพธ์ปัจจุบัน / current result:{' '}
                <span className="font-mono font-semibold">
                  {(coefficients.slope * latestRaw + coefficients.intercept).toFixed(2)} NTU
                </span>
                <span className="text-muted-foreground"> (raw {latestRaw})</span>
              </p>
            )}
          </>
        ) : (
          <>
            <div>
              <p className="text-muted-foreground text-sm">k-factor</p>
              <p className="font-mono text-2xl font-semibold">{coefficients.k.toFixed(4)}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              ppm ที่ปรับเทียบ = k × ค่า TDS ดิบ / calibrated ppm = k × raw DFRobot reading
            </p>
          </>
        )}
        {updated && !pending && (
          <p className="text-xs text-muted-foreground">อัปเดตล่าสุด / last saved: {new Date(updated).toLocaleString()}</p>
        )}
      </CardContent>
    </Card>
  )
}
