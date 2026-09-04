import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import { ThemeProvider } from 'next-themes'
import { Toaster } from 'sonner'
// Self-hosted webfonts (works offline on the LAN, no Google Fonts CDN
// dependency) for the 'Noto Sans Thai', 'Inter' stack declared in
// index.css's `body { font-family: ... }`. Only the weights actually used
// by Tailwind utility classes across the app (400 body text, 500
// font-medium, 600 font-semibold -- no font-bold/700 usage found) are
// imported, to keep the bundle lean.
import '@fontsource/noto-sans-thai/400.css'
import '@fontsource/noto-sans-thai/500.css'
import '@fontsource/noto-sans-thai/600.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import './index.css'
import App from './App'
import { LanguageProvider, translateStandalone } from '@/lib/i18n'
import { DashboardPrefsProvider } from '@/lib/DashboardPrefsProvider'
import { RoleProvider } from '@/lib/RoleProvider'
import { isPushSupported, registerServiceWorker } from '@/lib/push'

// Registering the service worker doesn't itself prompt for permission or
// subscribe to push -- that only happens when the user opts in via
// NotificationSettings -- so it's safe to do unconditionally at startup.
if (isPushSupported()) {
  void registerServiceWorker()
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

interface ErrorBoundaryState {
  hasError: boolean
}

/** Catches render-time errors (e.g. a null field in a history row) so a single bad
 *  reading blanks a fallback screen instead of the entire /app dashboard. */
class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Aqua Monitor crashed:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
          <div className="space-y-1">
            <p className="text-lg font-semibold">{translateStandalone('common.error')}</p>
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {translateStandalone('common.reload')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider
        attribute="data-theme"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <LanguageProvider>
          <DashboardPrefsProvider>
            <RoleProvider>
              <MotionConfig reducedMotion="user">
                <QueryClientProvider client={queryClient}>
                  <App />
                  <Toaster richColors position="top-right" />
                </QueryClientProvider>
              </MotionConfig>
            </RoleProvider>
          </DashboardPrefsProvider>
        </LanguageProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
)
