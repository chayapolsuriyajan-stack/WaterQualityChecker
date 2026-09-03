/**
 * Calibration tab: live `/calibration` state + optimistic apply flow for the
 * two backend-supported sensors (turbidity 2-point, tds k-factor). Temperature
 * and EC are read-only informational cards (factory-calibrated / derived).
 *
 * Optimistic "Apply": onMutate snapshots the ['calibration'] cache, patches in
 * a client-predicted coefficient, and fires a success toast immediately so the
 * UI feels instant; the mutationFn then actually runs capture(s) -> save ->
 * mode{enabled:true} in the background. onError rolls back + toasts an error.
 * onSettled always refetches to reconcile with the server's real answer.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { motion, useReducedMotion } from 'motion/react'
import {
  capturePoint,
  deletePoint,
  getCalibration,
  resetCalibration,
  saveCalibration,
  setCalibrationMode,
} from '@/lib/api'
import type { CalibrationState } from '@/lib/types'
import { useT } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SensorList } from './SensorList'
import type { CalibrationSensorId } from './SensorList'
import { TwoPointForm } from './TwoPointForm'
import type { TwoPointFormSubmitRow } from './TwoPointForm'
import { CoefficientPreview } from './CoefficientPreview'
import type { TdsCoefficients, TurbidityCoefficients } from './CoefficientPreview'
import { WifiPanel } from './WifiPanel'

const QUERY_KEY = ['calibration'] as const

type CalibratableSensor = 'turbidity' | 'tds' | 'flow'

interface ApplyVariables {
  sensor: CalibratableSensor
  rows: TwoPointFormSubmitRow[]
}

/** Client-side linear fit from 2 (adc, ntu) rows — used only for the optimistic preview. */
function predictTurbidity(
  rows: TwoPointFormSubmitRow[],
  latestRaw: number | null,
): TurbidityCoefficients | null {
  if (rows.length < 2) return null
  const points = rows.map((row) => ({ x: row.raw ?? latestRaw, y: row.reference }))
  if (points.some((p) => p.x == null)) return null
  const [p1, p2] = points as { x: number; y: number }[]
  if (p1.x === p2.x) return null
  const slope = (p2.y - p1.y) / (p2.x - p1.x)
  const intercept = p1.y - slope * p1.x
  return { slope, intercept }
}

/** Client-side k = reference / measured — used only for the optimistic preview. */
function predictTds(rows: TwoPointFormSubmitRow[]): TdsCoefficients | null {
  const row = rows[0]
  if (!row || row.raw == null || row.raw === 0) return null
  return { k: row.reference / row.raw }
}

function applyOptimisticPatch(
  state: CalibrationState,
  sensor: CalibratableSensor,
  predicted: TurbidityCoefficients | TdsCoefficients | null,
): CalibrationState {
  if (sensor === 'turbidity') {
    return {
      ...state,
      mode: true,
      turbidity: {
        ...state.turbidity,
        coefficients: predicted ? (predicted as TurbidityCoefficients) : state.turbidity.coefficients,
      },
    }
  }
  if (sensor === 'flow') {
    return {
      ...state,
      mode: true,
      flow: {
        ...state.flow,
        coefficients: predicted ? (predicted as TdsCoefficients) : state.flow.coefficients,
      },
    }
  }
  return {
    ...state,
    mode: true,
    tds: {
      ...state.tds,
      coefficients: predicted ? (predicted as TdsCoefficients) : state.tds.coefficients,
    },
  }
}

export function CalibrationView() {
  const { t } = useT()
  const [activeSensor, setActiveSensor] = useState<CalibrationSensorId>('turbidity')
  const [pendingSensor, setPendingSensor] = useState<CalibratableSensor | null>(null)
  const queryClient = useQueryClient()
  const reduceMotion = useReducedMotion()

  const applyMutation = useMutation({
    mutationFn: async ({ sensor, rows }: ApplyVariables) => {
      // Turbidity and flow send the typed `raw` value (turbidity: ADC; flow: the manually
      // counted pulses -- there's no meaningful live average to fall back to for a "pour a
      // known volume and count total pulses" calibration). TDS deliberately never sends its
      // raw field -- it's preview-only there, always using the server's live averaged
      // voltage instead (see TwoPointForm's file header comment).
      const sendsRaw = sensor === 'turbidity' || sensor === 'flow'
      for (const row of rows) {
        if (sendsRaw) {
          await capturePoint({ sensor, reference: row.reference, raw: row.raw })
        } else {
          await capturePoint({ sensor, reference: row.reference })
        }
      }
      await saveCalibration()
      return setCalibrationMode(true)
    },
    onMutate: async ({ sensor, rows }: ApplyVariables) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY })
      const previous = queryClient.getQueryData<CalibrationState>(QUERY_KEY)
      setPendingSensor(sensor)
      if (previous) {
        const latestRaw =
          sensor === 'turbidity'
            ? previous.latestRaw.turbidity
            : sensor === 'flow'
              ? previous.latestRaw.flowRaw
              : previous.latestRaw.tdsVoltage
        const predicted =
          sensor === 'turbidity' ? predictTurbidity(rows, latestRaw) : predictTds(rows)
        queryClient.setQueryData<CalibrationState>(QUERY_KEY, applyOptimisticPatch(previous, sensor, predicted))
      }
      toast.success(
        sensor === 'turbidity'
          ? t('calib.applyingTurbidity')
          : sensor === 'flow'
            ? t('calib.applyingFlow')
            : t('calib.applyingTds'),
      )
      return { previous }
    },
    onError: (_err, { sensor }, context) => {
      if (context?.previous) queryClient.setQueryData(QUERY_KEY, context.previous)
      toast.error(
        sensor === 'turbidity'
          ? t('calib.failedTurbidity')
          : sensor === 'flow'
            ? t('calib.failedFlow')
            : t('calib.failedTds'),
      )
    },
    onSettled: () => {
      setPendingSensor(null)
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })

  // Poll live calibration state, but pause while an apply is in flight — otherwise the
  // next scheduled poll (captures + save can easily exceed 1.5s) overwrites the
  // optimistic patch from onMutate with stale pre-save server state before the
  // mutation's own onSettled refetch has a chance to reconcile.
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getCalibration,
    refetchInterval: applyMutation.isPending ? false : 1500,
  })

  const deleteMutation = useMutation({
    mutationFn: (args: { sensor: CalibratableSensor; index: number }) => deletePoint(args),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  const resetMutation = useMutation({
    mutationFn: (sensor: CalibratableSensor) => resetCalibration(sensor),
    onSuccess: () => {
      toast.success(t('calib.resetSuccess'))
    },
    onError: () => {
      toast.error(t('calib.resetFailed'))
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  const modeMutation = useMutation({
    mutationFn: (enabled: boolean) => setCalibrationMode(enabled),
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY })
      const previous = queryClient.getQueryData<CalibrationState>(QUERY_KEY)
      if (previous) queryClient.setQueryData<CalibrationState>(QUERY_KEY, { ...previous, mode: enabled })
      return { previous }
    },
    onError: (_err, _enabled, context) => {
      if (context?.previous) queryClient.setQueryData(QUERY_KEY, context.previous)
      toast.error(t('calib.modeChangeFailed'))
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  const transition = reduceMotion ? { duration: 0 } : { duration: 0.16 }

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t('calib.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('calib.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('calib.modeLabel')}</span>
          <Button
            type="button"
            size="sm"
            variant={data?.mode ? 'default' : 'outline'}
            disabled={modeMutation.isPending || isLoading}
            onClick={() => modeMutation.mutate(!data?.mode)}
          >
            {data?.mode ? t('calib.modeOn') : t('calib.modeOff')}
          </Button>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
        <SensorList active={activeSensor} onSelect={setActiveSensor} calibration={data} />

        {/* Keyed motion.div without AnimatePresence -- mode="wait" deadlocks on
            React 19 + motion 12 (exiting child never resolves, so the next panel
            never mounts). Remounting on `activeSensor` replays the entrance anim. */}
        <div>
          <motion.div
            key={activeSensor}
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transition}
            className="space-y-4"
          >
            {activeSensor === 'temperature' && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('calib.temperatureTitle')}</CardTitle>
                  <CardDescription>DS18B20</CardDescription>
                </CardHeader>
                <CardContent>
                  <Badge variant="secondary" className="mb-2">
                    {t('calib.noCalibrationNeeded')}
                  </Badge>
                  <p className="text-sm text-muted-foreground">{t('calib.factoryCalibrated')}</p>
                </CardContent>
              </Card>
            )}

            {activeSensor === 'ec' && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('calib.ecTitle')}</CardTitle>
                  <CardDescription>µS/cm</CardDescription>
                </CardHeader>
                <CardContent>
                  <Badge variant="secondary" className="mb-2">
                    {t('calib.noSeparateSensor')}
                  </Badge>
                  <p className="text-sm text-muted-foreground">{t('calib.derivedFromTds')}</p>
                </CardContent>
              </Card>
            )}

            {activeSensor === 'turbidity' && data && (
              <>
                <TwoPointForm
                  sensor="turbidity"
                  pointCount={2}
                  existingPoints={data.turbidity.points.map((p) => ({
                    reference: p.reference,
                    raw: p.raw,
                    label: p.label,
                  }))}
                  latestRaw={data.latestRaw.turbidity}
                  applying={applyMutation.isPending && applyMutation.variables?.sensor === 'turbidity'}
                  onApply={(rows) => applyMutation.mutate({ sensor: 'turbidity', rows })}
                  onDeletePoint={(index) => deleteMutation.mutate({ sensor: 'turbidity', index })}
                />
                <CoefficientPreview
                  sensor="turbidity"
                  coefficients={data.turbidity.coefficients}
                  latestRaw={data.latestRaw.turbidity}
                  pending={pendingSensor === 'turbidity'}
                  updated={data.turbidity.updated}
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={resetMutation.isPending}
                    onClick={() => resetMutation.mutate('turbidity')}
                  >
                    {t('calib.resetTurbidity')}
                  </Button>
                </div>
              </>
            )}

            {activeSensor === 'tds' && data && (
              <>
                <TwoPointForm
                  sensor="tds"
                  pointCount={1}
                  existingPoints={data.tds.points.map((p) => ({
                    reference: p.reference,
                    raw: p.rawVoltage,
                    label: p.label,
                  }))}
                  latestRaw={data.latestRaw.tdsVoltage}
                  applying={applyMutation.isPending && applyMutation.variables?.sensor === 'tds'}
                  onApply={(rows) => applyMutation.mutate({ sensor: 'tds', rows })}
                  onDeletePoint={(index) => deleteMutation.mutate({ sensor: 'tds', index })}
                />
                <CoefficientPreview
                  sensor="tds"
                  coefficients={data.tds.coefficients}
                  latestRaw={data.latestRaw.tdsVoltage}
                  pending={pendingSensor === 'tds'}
                  updated={data.tds.updated}
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={resetMutation.isPending}
                    onClick={() => resetMutation.mutate('tds')}
                  >
                    {t('calib.resetTds')}
                  </Button>
                </div>
              </>
            )}

            {activeSensor === 'flow' && data && (
              <>
                <TwoPointForm
                  sensor="flow"
                  pointCount={1}
                  existingPoints={data.flow.points.map((p) => ({
                    reference: p.reference,
                    raw: p.rawPulses,
                    label: p.label,
                  }))}
                  latestRaw={data.latestRaw.flowRaw}
                  applying={applyMutation.isPending && applyMutation.variables?.sensor === 'flow'}
                  onApply={(rows) => applyMutation.mutate({ sensor: 'flow', rows })}
                  onDeletePoint={(index) => deleteMutation.mutate({ sensor: 'flow', index })}
                />
                <CoefficientPreview
                  sensor="flow"
                  coefficients={data.flow.coefficients}
                  latestRaw={data.latestRaw.flowRaw}
                  pending={pendingSensor === 'flow'}
                  updated={data.flow.updated}
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={resetMutation.isPending}
                    onClick={() => resetMutation.mutate('flow')}
                  >
                    {t('calib.resetFlow')}
                  </Button>
                </div>
              </>
            )}

            {(activeSensor === 'turbidity' || activeSensor === 'tds' || activeSensor === 'flow') && !data && isLoading && (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">{t('calib.loading')}</CardContent>
              </Card>
            )}

            {/* WiFi isn't a calibratable sensor (no /calibration coefficients) -- it's the USB
                provisioning panel, entirely independent of the `data`/`isLoading` state above. */}
            {activeSensor === 'wifi' && <WifiPanel />}
          </motion.div>
        </div>
      </div>
    </div>
  )
}
