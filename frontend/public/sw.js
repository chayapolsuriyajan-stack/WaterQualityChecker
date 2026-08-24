// HydroMonitor push notification service worker.
// Plain vanilla JS -- this runs as a raw browser Service Worker, not through
// Vite's build pipeline (see vite.config.ts / CLAUDE.md's Frontend section).
// No imports/exports, no TypeScript.

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'HydroMonitor Alert', {
      body: data.body || '',
      icon: data.icon || '/favicon.svg',
      badge: data.badge || '/favicon.svg',
      tag: data.tag,
      actions: data.actions || [],
      data: { url: '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  if (event.action === 'dismiss') {
    return
  }
  // 'view' action, or a click on the notification body itself (no action id).
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'))
})
