/**
 * Single-button language toggle. Only two languages exist, so a dropdown
 * would be overkill — one click flips `en` <-> `th` via `toggleLang()`.
 *
 * Shows the label of the language you'd switch TO (not the current one):
 * it reads as an action ("press this to get Thai"), matching how the
 * button behaves, rather than as a status readout of the current language.
 */
import { Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

interface LanguageSwitcherProps {
  className?: string
  /** Icon-only compact form, for the collapsed tablet rail. */
  collapsed?: boolean
}

export function LanguageSwitcher({ className, collapsed = false }: LanguageSwitcherProps) {
  const { t, lang, toggleLang } = useT()

  const targetLang = lang === 'en' ? 'th' : 'en'
  const targetLabel = targetLang === 'en' ? t('lang.en') : t('lang.th')

  return (
    <Button
      type="button"
      variant="ghost"
      size={collapsed ? 'icon' : 'default'}
      onClick={toggleLang}
      aria-label={t('lang.switch')}
      title={targetLabel}
      className={cn(
        'min-h-11 min-w-11 gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        !collapsed && 'justify-start px-3',
        className,
      )}
    >
      <Globe className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
      {!collapsed && <span className="truncate">{targetLabel}</span>}
    </Button>
  )
}
