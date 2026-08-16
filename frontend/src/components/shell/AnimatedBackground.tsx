import { useEffect, useRef } from 'react'

interface AnimatedBackgroundProps {
  /** When true, render a single static frame and never start the animation loop. */
  reducedMotion?: boolean
}

const DOT_SPACING = 32
const DOT_RADIUS = 1.4
/** Dots shrink toward this fraction of DOT_RADIUS at the low point of their wave, growing
 * back to full size at the high point — a cheap depth cue (near dots read "bigger"). */
const DOT_RADIUS_MIN_SCALE = 0.6
const WAVE_FREQ = 0.012
const WAVE_SPEED = 0.00035
const WAVE_AMPLITUDE = 10
const DOT_ALPHA = 0.14
const MAX_DPR = 1.5
/** Vignette fade: fraction of the canvas's half-diagonal where the fade starts / ends. */
const VIGNETTE_START = 0.35
const VIGNETTE_END = 1.05
const VIGNETTE_ALPHA = 0.9

/** Resolved `--primary` / `--accent` HSL triples read from the current theme, plus the
 * plain `--background` triple used to paint the edge vignette. */
interface ThemeColors {
  primary: string
  accent: string
  background: string
}

function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement)
  const primary = style.getPropertyValue('--primary').trim()
  const accent = style.getPropertyValue('--accent').trim()
  const background = style.getPropertyValue('--background').trim()
  return {
    primary: primary ? `hsl(${primary} / ${DOT_ALPHA})` : `hsl(168 76% 42% / ${DOT_ALPHA})`,
    accent: accent ? `hsl(${accent} / ${DOT_ALPHA})` : `hsl(168 76% 96% / ${DOT_ALPHA})`,
    background: background || '200 32% 8%',
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
    let vignette: CanvasGradient | null = null

    /** Radial fade from transparent (center) to `--background` (edges), so the dot
     * grid reads as receding into the page instead of tiling flatly edge-to-edge.
     * Rebuilt whenever size or theme colors change -- cheap, and lets `draw` just
     * paint the cached gradient instead of recomputing it every frame. */
    const buildVignette = () => {
      if (width === 0 || height === 0) return
      const cx = width / 2
      const cy = height / 2
      const maxRadius = Math.sqrt(cx * cx + cy * cy)
      const grad = ctx.createRadialGradient(
        cx,
        cy,
        maxRadius * VIGNETTE_START,
        cx,
        cy,
        maxRadius * VIGNETTE_END,
      )
      grad.addColorStop(0, `hsl(${colors.background} / 0)`)
      grad.addColorStop(1, `hsl(${colors.background} / ${VIGNETTE_ALPHA})`)
      vignette = grad
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      buildVignette()
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
          const wave = Math.sin(x * WAVE_FREQ + t * WAVE_SPEED + rowPhase)
          const y = baseY + wave * WAVE_AMPLITUDE
          // Dots near the crest of their wave render slightly larger than dots
          // near the trough -- a cheap parallax-like depth cue with no extra draws.
          const radius = DOT_RADIUS * (DOT_RADIUS_MIN_SCALE + (1 - DOT_RADIUS_MIN_SCALE) * ((wave + 1) / 2))
          ctx.beginPath()
          ctx.arc(x, y, radius, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      if (vignette) {
        ctx.fillStyle = vignette
        ctx.fillRect(0, 0, width, height)
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
      buildVignette()
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
