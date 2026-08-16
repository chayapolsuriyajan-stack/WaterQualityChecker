/**
 * Portal-rendered spotlight overlay for the guided tour. Renders a dim
 * backdrop with an SVG-mask cutout around the active step's target element
 * (resolved via `data-tour="..."` -- see tourSteps.ts), plus a tooltip card
 * with Next/Back/Skip controls. Centered (no-target) steps -- welcome/done --
 * just show the card over a plain dim backdrop, no cutout.
 *
 * z-[100]: above the app's existing z-50 dialogs/sheets/toasts (see the
 * `z-50` convention in components/ui/dialog.tsx, sheet.tsx, tooltip.tsx),
 * since the tour can point at UI while other overlays are technically still
 * in the DOM.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { useT } from '@/lib/i18n'
import { useTour } from './TourProvider'

const SPOTLIGHT_PADDING = 8
const SPOTLIGHT_RADIUS = 12
const CARD_GAP = 14
const CARD_WIDTH = 320
const VIEWPORT_MARGIN = 16
// The card's real height varies with translated copy, but we position it
// before it's ever rendered (no ref/measure pass, to keep this simple), so
// clamping uses a generous fixed estimate instead. Body copy in tourSteps.ts
// stays short enough that actual height rarely exceeds this.
const CARD_HEIGHT_ESTIMATE = 200

interface CardStyle {
  top: number
  left: number
  transform: string
}

function computeCardStyle(rect: DOMRect | null, placement: 'top' | 'bottom' | 'left' | 'right' = 'bottom'): CardStyle | null {
  if (!rect) return null

  let top: number
  let left: number
  let transform: string

  switch (placement) {
    case 'top':
      top = rect.top - CARD_GAP
      left = rect.left + rect.width / 2
      transform = 'translate(-50%, -100%)'
      break
    case 'left':
      top = rect.top + rect.height / 2
      left = rect.left - CARD_GAP
      transform = 'translate(-100%, -50%)'
      break
    case 'right':
      top = rect.top + rect.height / 2
      left = rect.right + CARD_GAP
      transform = 'translate(0, -50%)'
      break
    case 'bottom':
    default:
      top = rect.bottom + CARD_GAP
      left = rect.left + rect.width / 2
      transform = 'translate(-50%, 0)'
      break
  }

  // Clamp so the ~CARD_WIDTH card never overflows the viewport. The valid
  // range for `left` depends on which edge the transform anchors to.
  const halfCard = CARD_WIDTH / 2
  if (placement === 'left') {
    left = Math.min(Math.max(left, VIEWPORT_MARGIN + CARD_WIDTH), window.innerWidth - VIEWPORT_MARGIN)
  } else if (placement === 'right') {
    left = Math.min(Math.max(left, VIEWPORT_MARGIN), window.innerWidth - VIEWPORT_MARGIN - CARD_WIDTH)
  } else {
    left = Math.min(
      Math.max(left, VIEWPORT_MARGIN + halfCard),
      window.innerWidth - VIEWPORT_MARGIN - halfCard,
    )
  }

  // Clamp vertically too, reserving room for the card's own (estimated)
  // height so it can't render partly off the top/bottom edge -- how much
  // room depends on which edge of the card the transform anchors at the
  // `top` coordinate (its top edge, its bottom edge, or its vertical center).
  if (placement === 'top') {
    top = Math.min(Math.max(top, VIEWPORT_MARGIN + CARD_HEIGHT_ESTIMATE), window.innerHeight - VIEWPORT_MARGIN)
  } else if (placement === 'bottom') {
    top = Math.min(Math.max(top, VIEWPORT_MARGIN), window.innerHeight - VIEWPORT_MARGIN - CARD_HEIGHT_ESTIMATE)
  } else {
    const halfHeight = CARD_HEIGHT_ESTIMATE / 2
    top = Math.min(
      Math.max(top, VIEWPORT_MARGIN + halfHeight),
      window.innerHeight - VIEWPORT_MARGIN - halfHeight,
    )
  }

  return { top, left, transform }
}

export function TourOverlay() {
  const { isActive, currentStep, currentIndex, steps, view, next, prev, skip } = useTour()
  const { t } = useT()
  const [rect, setRect] = useState<DOMRect | null>(null)

  // Resolve the current step's target, auto-advancing past steps whose target
  // doesn't exist in the DOM (e.g. a desktop-only element at a mobile
  // viewport) instead of showing a broken/empty spotlight. Also tracks the
  // target's position across resize/scroll/layout changes.
  useEffect(() => {
    if (!isActive || !currentStep) return

    if (!currentStep.targetSelector) {
      setRect(null)
      return
    }

    const el = document.querySelector(currentStep.targetSelector)
    if (!el) {
      next()
      return
    }

    const update = () => setRect(el.getBoundingClientRect())
    update()

    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(el)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
    // `view` isn't read directly here, but a tab switch can change whether
    // the target exists/where it sits, so re-resolve when it commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, currentStep, view, next])

  if (!isActive || !currentStep) return null

  const isFirst = currentIndex === 0
  const isLast = currentIndex === steps.length - 1
  const cardStyle = currentStep.targetSelector ? computeCardStyle(rect, currentStep.placement) : null

  const spotlightRect = rect
    ? {
        x: rect.left - SPOTLIGHT_PADDING,
        y: rect.top - SPOTLIGHT_PADDING,
        width: rect.width + SPOTLIGHT_PADDING * 2,
        height: rect.height + SPOTLIGHT_PADDING * 2,
      }
    : null

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[100]">
      <svg className="h-full w-full">
        <defs>
          <mask id="hydro-tour-spotlight-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {spotlightRect && (
              <rect
                x={spotlightRect.x}
                y={spotlightRect.y}
                width={spotlightRect.width}
                height={spotlightRect.height}
                rx={SPOTLIGHT_RADIUS}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(15, 23, 42, 0.65)"
          mask="url(#hydro-tour-spotlight-mask)"
        />
      </svg>

      {/*
        Positioning lives on this plain (non-motion) div. motion.div takes full
        ownership of the `transform` CSS property for its own scale animation
        below -- an inline `transform: translate(...)` passed into a
        motion.div's `style` prop gets silently overwritten once the
        animation settles, which broke centering/placement here originally.
        Splitting the concerns (this div positions, the motion.div inside
        only fades/scales in place) avoids that fight over `transform`.
      */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hydro-tour-title"
        className="pointer-events-auto fixed w-[calc(100vw-2rem)] max-w-[320px]"
        style={
          cardStyle
            ? { top: cardStyle.top, left: cardStyle.left, transform: cardStyle.transform }
            : {
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
              }
        }
      >
        <motion.div
          key={currentStep.id}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="rounded-xl border border-border bg-card p-4 text-foreground shadow-xl"
        >
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t('tour.stepCounter', { current: currentIndex + 1, total: steps.length })}
          </p>
          <h3 id="hydro-tour-title" className="mb-1.5 text-sm font-semibold text-foreground">
            {t(currentStep.titleKey)}
          </h3>
          <p className="mb-4 text-sm text-muted-foreground">{t(currentStep.bodyKey)}</p>

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={skip}
              className="rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {t('tour.skip')}
            </button>

            <div className="flex items-center gap-2">
              {!isFirst && (
                <button
                  type="button"
                  onClick={prev}
                  className="rounded-md border border-input px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {t('tour.back')}
                </button>
              )}
              <button
                type="button"
                onClick={next}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {isLast ? t('tour.done') : t('tour.next')}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>,
    document.body,
  )
}
