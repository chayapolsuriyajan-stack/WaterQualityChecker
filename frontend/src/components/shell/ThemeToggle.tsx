/**
 * Light/dark theme toggle button. Reads/writes theme via next-themes'
 * `useTheme()` (see main.tsx's `ThemeProvider attribute="data-theme"`).
 *
 * Hydration-safe: `resolvedTheme` is undefined until next-themes mounts on
 * the client, so we render a stable placeholder icon until then to avoid a
 * flash/mismatch between server- and client-rendered markup.
 */
import { useEffect, useState, type JSX } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

interface ThemeToggleProps {
  className?: string
}

export function ThemeToggle({ className }: ThemeToggleProps): JSX.Element {
  const { resolvedTheme, setTheme } = useTheme()
  const { t } = useT()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const isDark = mounted && resolvedTheme === 'dark'
  const nextModeLabel = isDark ? t('theme.light') : t('theme.dark')

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('h-11 w-11 min-h-11 min-w-11 focus-visible:ring-2 focus-visible:ring-offset-2', className)}
      aria-label={t('theme.toggle')}
      title={nextModeLabel}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      suppressHydrationWarning
    >
      {mounted && isDark ? (
        <Sun aria-hidden="true" />
      ) : (
        <Moon aria-hidden="true" />
      )}
    </Button>
  )
}
