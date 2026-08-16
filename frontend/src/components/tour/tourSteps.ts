/**
 * Ordered step list for the first-time onboarding tour (see TourProvider /
 * TourOverlay). Each step optionally targets a `data-tour="..."` element
 * (resolved via `document.querySelector` at render time -- see TourOverlay)
 * and optionally requests a `view` switch when the tour advances onto it, so
 * a step can show UI that only exists on a non-active tab.
 */
import type { ViewId } from '@/components/shell/Sidebar'
import type { MessageKey } from '@/lib/strings'

export interface TourStep {
  id: string
  /** `data-tour` attribute value to spotlight. Omitted -> centered card over a plain dim backdrop (welcome/done). */
  targetSelector?: string
  titleKey: MessageKey
  bodyKey: MessageKey
  /** Switch to this view when the step becomes active, so its target exists in the DOM. */
  view?: ViewId
  placement?: 'top' | 'bottom' | 'left' | 'right'
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    titleKey: 'tour.welcome.title',
    bodyKey: 'tour.welcome.body',
  },
  {
    id: 'nav-dashboard',
    targetSelector: '[data-tour="nav-dashboard"]',
    titleKey: 'tour.navDashboard.title',
    bodyKey: 'tour.navDashboard.body',
    view: 'dashboard',
    placement: 'right',
  },
  {
    id: 'param-grid',
    targetSelector: '[data-tour="param-grid"]',
    titleKey: 'tour.paramGrid.title',
    bodyKey: 'tour.paramGrid.body',
    view: 'dashboard',
    placement: 'bottom',
  },
  {
    id: 'quick-view',
    targetSelector: '[data-tour="quick-view"]',
    titleKey: 'tour.quickView.title',
    bodyKey: 'tour.quickView.body',
    view: 'dashboard',
    placement: 'left',
  },
  {
    id: 'nav-calibration',
    targetSelector: '[data-tour="nav-calibration"]',
    titleKey: 'tour.navCalibration.title',
    bodyKey: 'tour.navCalibration.body',
    view: 'dashboard',
    placement: 'right',
  },
  {
    id: 'nav-history',
    targetSelector: '[data-tour="nav-history"]',
    titleKey: 'tour.navHistory.title',
    bodyKey: 'tour.navHistory.body',
    view: 'dashboard',
    placement: 'right',
  },
  {
    id: 'theme-toggle',
    targetSelector: '[data-tour="theme-toggle"]',
    titleKey: 'tour.themeToggle.title',
    bodyKey: 'tour.themeToggle.body',
    view: 'dashboard',
    placement: 'right',
  },
  {
    id: 'lang-toggle',
    targetSelector: '[data-tour="lang-toggle"]',
    titleKey: 'tour.langToggle.title',
    bodyKey: 'tour.langToggle.body',
    view: 'dashboard',
    placement: 'right',
  },
  {
    id: 'done',
    titleKey: 'tour.done.title',
    bodyKey: 'tour.done.body',
  },
]
