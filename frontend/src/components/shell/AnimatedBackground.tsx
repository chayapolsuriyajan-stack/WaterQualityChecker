import { useEffect, useRef } from 'react'

interface AnimatedBackgroundProps {
  /** When true, render a single static frame and never start the animation loop. */
  reducedMotion?: boolean
}

const DOT_SPACING = 32
const DOT_RADIUS = 1.4
const WAVE_FREQ = 0.012
const WAVE_SPEED = 0.00035
const WAVE_AMPLITUDE = 10
const DOT_ALPHA = 0.14
const MAX_DPR = 1.5

/** Resolved `--primary` / `--accent` HSL triples read from the current theme. */
interface ThemeColors {
  primary: string
  accent: string
}

function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement)
  const primary = style.getPropertyValue('--primary').trim()
  const accent = style.getPropertyValue('--accent').trim()
  return {
    primary: primary ? `hsl(${primary} / ${DOT_ALPHA})` : `hsl(168 76% 42% / ${DOT_ALPHA})`,
    accent: accent ? `hsl(${accent} / ${DOT_ALPHA})` : `hsl(168 76% 96% / ${DOT_ALPHA})`,
  }
}

/**
 * Ambient wavy-dot background for the whole app shell. Fixed full-viewport
 * canvas, mounted once behind Sidebar/main content (see App.tsx). Paints no
 * fill of its own — only low-alpha dots — so `--background` still shows
 * through underneath and text-contrast math against it stays valid.
 *
 * Colors are re-read from the DOM (not hardcoded) whenever the theme changes,
 * via a MutationObserver on <html> (explicit light/dark toggle) and a
 * matchMedia listener (OS-default-dark with no explicit data-theme set) —
 * the app has three theme states (see index.css) and both are needed to
 * cover all of them.
 */
export function AnimatedBackground({ reducedMotion = false }: AnimatedBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let rafId: number | null = null
    let width = 0
    let height = 0
    let colors = readThemeColors()

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height)
      const cols = Math.ceil(width / DOT_SPACING) + 1
      const rows = Math.ceil(height / DOT_SPACING) + 1

      for (let row = 0; row < rows; row++) {
        const rowPhase = row * 0.6
        const useAccent = row % 2 === 0
        ctx.fillStyle = useAccent ? colors.accent : colors.primary
        for (let col = 0; col < cols; col++) {
          const x = col * DOT_SPACING
          const baseY = row * DOT_SPACING
          const y = baseY + Math.sin(x * WAVE_FREQ + t * WAVE_SPEED + rowPhase) * WAVE_AMPLITUDE
          ctx.beginPath()
          ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resize()
        draw(reducedMotion ? 0 : performance.now())
      }, 120)
    }

    const loop = (now: number) => {
      draw(now)
      rafId = requestAnimationFrame(loop)
    }

    const start = () => {
      if (rafId !== null || reducedMotion) return
      rafId = requestAnimationFrame(loop)
    }

    const stop = () => {
      if (rafId === null) return
      cancelAnimationFrame(rafId)
      rafId = null
    }

    resize()
    draw(0)
    if (!reducedMotion) start()

    const onVisibilityChange = () => {
      if (document.hidden) stop()
      else start()
    }

    const recolor = () => {
      colors = readThemeColors()
      if (reducedMotion) draw(0)
    }

    const mutationObserver = new MutationObserver(recolor)
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    })

    const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    darkMediaQuery.addEventListener('change', recolor)

    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stop()
      if (resizeTimer) clearTimeout(resizeTimer)
      mutationObserver.disconnect()
      darkMediaQuery.removeEventListener('change', recolor)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [reducedMotion])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0"
    />
  )
}
