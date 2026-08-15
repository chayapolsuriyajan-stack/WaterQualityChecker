import { useEffect, useState } from 'react'
import { MapPin, Radio, Wifi, WifiOff } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useSensorData } from '@/lib/SensorProvider'
import { QuickViewSummary } from './QuickViewSummary'

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

interface RightContextColumnProps {
  className?: string
}

/** Dashboard-only right column: station identity/GPS/connectivity/clock card, plus the Quick View summary card below it. */
export function RightContextColumn({ className }: RightContextColumnProps) {
  const { connected } = useSensorData()
  const { t } = useT()
  const now = useClock()

  const timeLabel = now.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const dateLabel = now.toLocaleDateString('en-CA')

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="rounded-xl border border-border bg-card/70 p-4 shadow-sm backdrop-blur-md">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">{t('app.siteName')}</h3>
            <p className="truncate text-xs text-muted-foreground">{t('app.subtitle')}</p>
          </div>
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            AK-001
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span>18.80°N, 98.95°E</span>
        </div>

        <div className="my-3 h-px bg-border" />

        <div className="flex items-center justify-between">
          <div
            className={cn(
              'flex items-center gap-1.5 text-xs font-medium',
              connected ? 'text-success' : 'text-warning',
            )}
          >
            {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            <span>{connected ? t('status.online') : t('status.offline')}</span>
            {connected && (
              <Radio className="h-3 w-3 animate-pulse text-success" aria-hidden="true" />
            )}
          </div>
          <div className="text-right font-mono text-xs text-muted-foreground">
            <div>{timeLabel}</div>
            <div className="text-[10px] opacity-70">{dateLabel}</div>
          </div>
        </div>
      </div>

      <QuickViewSummary />
    </div>
  )
}
