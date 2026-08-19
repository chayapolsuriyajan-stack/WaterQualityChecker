/**
 * Web Push helpers: service worker registration, subscribe/unsubscribe, and
 * per-parameter preference get/save. All fetch paths are relative so this
 * works same-origin whether served at / in prod or proxied in dev (see
 * vite.config.ts and lib/api.ts's header comment) -- never hardcode a host.
 *
 * Detection/dispatch happens server-side (main.py); this module is purely
 * the browser-side plumbing to opt a device in/out and manage prefs.
 */

export type PushParam = 'temperature' | 'turbidity' | 'tds' | 'ec'
export type PushPrefs = Record<PushParam, { warn: boolean; danger: boolean }>

export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    window.isSecureContext
  )
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null
  try {
    return await navigator.serviceWorker.register('/sw.js')
  } catch (err) {
    console.error('Service worker registration failed:', err)
    return null
  }
}

/** Standard base64url -> Uint8Array conversion for a VAPID applicationServerKey. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length))
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null
  return (await navigator.serviceWorker.getRegistration('/sw.js')) ?? registerServiceWorker()
}

export type SubscribeResult = { ok: true } | { ok: false; error: string }

export async function subscribeToPush(): Promise<SubscribeResult> {
  try {
    const registration = await getRegistration()
    if (!registration) return { ok: false, error: 'unsupported' }

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return { ok: false, error: 'permission-denied' }

    const keyRes = await fetch('/push/vapid-public-key')
    if (keyRes.status === 503) return { ok: false, error: 'vapid-unavailable' }
    if (!keyRes.ok) return { ok: false, error: `vapid-fetch-failed-${keyRes.status}` }
    const { publicKey } = (await keyRes.json()) as { publicKey: string }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })

    const subscribeRes = await fetch('/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    })
    if (!subscribeRes.ok) return { ok: false, error: `subscribe-failed-${subscribeRes.status}` }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export async function unsubscribeFromPush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const registration = await getRegistration()
    if (!registration) return { ok: true }

    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return { ok: true }

    await subscription.unsubscribe()
    await fetch('/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export async function getCurrentSubscriptionEndpoint(): Promise<string | null> {
  const registration = await getRegistration()
  if (!registration) return null
  const subscription = await registration.pushManager.getSubscription()
  return subscription?.endpoint ?? null
}

export async function getPushPreferences(endpoint: string): Promise<PushPrefs | null> {
  try {
    const res = await fetch(`/push/preferences?endpoint=${encodeURIComponent(endpoint)}`)
    if (!res.ok) return null
    const data = (await res.json()) as { prefs: PushPrefs }
    return data.prefs
  } catch {
    return null
  }
}

export async function savePushPreferences(endpoint: string, prefs: PushPrefs): Promise<boolean> {
  try {
    const res = await fetch('/push/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, prefs }),
    })
    return res.ok
  } catch {
    return false
  }
}
