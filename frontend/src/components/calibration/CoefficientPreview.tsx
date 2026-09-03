/**
 * Live read-out of the current (or optimistically predicted) coefficients for
 * a calibratable sensor, plus the resulting calibrated value for the latest
 * raw reading. Shared shape for turbidity (linear2: slope/intercept) and tds
 * (kfactor: k).
 */
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export type TurbidityCoefficients = { slope: number; intercept: number }
export type TdsCoefficients = { k: number }

interface CoefficientPreviewProps {
  sensor: 'turbidity' | 'tds' | 'flow'
  coefficients: TurbidityCoefficients | TdsCoefficients | null
  /** Live raw reading: ADC for turbidity, voltage for tds, pulse count for flow. */
  latestRaw: number | null
  /** True while an optimistic (unconfirmed) prediction is showing. */
  pending?: boolean
  updated?: string | null
  className?: string
}

function isTurbidity(
  sensor: 'turbidity' | 'tds' | 'flow',
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
  const { t } = useT()
  return (
    <Card className={cn(className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{t('calib.coefficientsTitle')}</CardTitle>
        {pending && (
          <Badge variant="outline" className="border-warning/50 text-warning">
            {t('calib.pending')}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!coefficients ? (
          <p className="text-sm text-muted-foreground">
            {t('calib.notCalibrated')} —{' '}
            {sensor === 'turbidity'
              ? t('calib.needTurbidityPoints')
              : sensor === 'flow'
                ? t('calib.needFlowPoints')
                : t('calib.needTdsPoints')}
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
                {t('calib.currentResult')}:{' '}
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
              {sensor === 'flow' ? t('calib.flowKFactorFormula') : t('calib.kFactorFormula')}
            </p>
          </>
        )}
        {updated && !pending && (
          <p className="text-xs text-muted-foreground">
            {t('calib.lastSaved')}: {new Date(updated).toLocaleString()}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
