/**
 * Replays the guided onboarding tour on demand, regardless of whether the
 * "seen" localStorage flag is already set (see TourProvider). Styled to
 * match ThemeToggle.tsx's icon-button conventions.
 */
import { HelpCircle, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useTour } from '@/components/tour/TourProvider'

const Icon: LucideIcon = HelpCircle

interface TourHelpButtonProps {
  className?: string
  /** Show the "Help" text next to the icon -- only where the layout has room (e.g. the expanded sidebar rail). */
  showLabel?: boolean
}

export function TourHelpButton({ className, showLabel = false }: TourHelpButtonProps) {
  const { start } = useTour()
  const { t } = useT()

  return (
    <Button
      type="button"
      variant="ghost"
      size={showLabel ? 'default' : 'icon'}
      className={cn(
        'h-11 min-h-11 min-w-11 gap-2 focus-visible:ring-2 focus-visible:ring-offset-2',
        !showLabel && 'w-11',
        className,
      )}
      aria-label={t('tour.helpButtonAria')}
      title={t('tour.helpButtonAria')}
      onClick={start}
    >
      <Icon aria-hidden="true" />
      {showLabel && <span>{t('tour.helpLabel')}</span>}
    </Button>
  )
}
