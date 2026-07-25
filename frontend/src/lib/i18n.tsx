/**
 * Language provider for the Aqua Monitor frontend. Wraps the app, persists the
 * active language to localStorage, and exposes a `t()` translator plus the
 * current language / setters via `useT()`.
 *
 * Default language is `en`. `t()` falls back to the `en` string if a key is
 * missing from `th`, and returns the key itself (never throws, never renders
 * "undefined") if the key is missing from both locales.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { messages, type Lang, type MessageKey } from './strings'

const STORAGE_KEY = 'aqua-lang'

function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'th'
}

function readStoredLang(): Lang {
  if (typeof window === 'undefined') return 'en'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isLang(stored) ? stored : 'en'
  } catch {
    // localStorage can throw in restrictive environments (private browsing, etc).
    return 'en'
  }
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  )
}

/** Resolve a single key -> string for a given (or stored) language, with en fallback. */
function resolve(key: MessageKey, lang?: Lang): string {
  const activeLang = lang ?? readStoredLang()
  const table = messages[activeLang]
  const value = table?.[key]
  if (typeof value === 'string') return value

  const enValue = messages.en[key]
  if (typeof enValue === 'string') return enValue

  return key
}

/** Non-hook translator for use outside the provider (e.g. main.tsx's error boundary). */
export function translateStandalone(key: MessageKey, lang?: Lang): string {
  return resolve(key, lang)
}

interface LanguageContextValue {
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
  lang: Lang
  setLang: (l: Lang) => void
  toggleLang: () => void
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang())

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try {
      window.localStorage.setItem(STORAGE_KEY, l)
    } catch {
      // Ignore write failures (private browsing, storage disabled, etc).
    }
  }, [])

  const toggleLang = useCallback(() => {
    setLang(lang === 'en' ? 'th' : 'en')
  }, [lang, setLang])

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) =>
      interpolate(resolve(key, lang), vars),
    [lang],
  )

  const value = useMemo<LanguageContextValue>(
    () => ({ t, lang, setLang, toggleLang }),
    [t, lang, setLang, toggleLang],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useT(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) {
    throw new Error('useT() must be used within a <LanguageProvider>')
  }
  return ctx
}
