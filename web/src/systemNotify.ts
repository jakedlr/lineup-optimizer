import type { RunNotice } from './notify'

/**
 * System notifications for a run that ends in a hidden tab (GLOSSARY: Run notification), through the
 * browser's own `Notification` API. `unsupported` covers an insecure context, a browser without the
 * API, and mobile browsers, where the constructor throws (Android Chrome) or the API is missing.
 */
export type SystemNotifyState = NotificationPermission | 'unsupported'

export const UNSUPPORTED_NOTE = 'Needs a desktop browser on localhost or HTTPS'
export const BLOCKED_NOTE = 'Notifications are blocked for this site in your browser'

const TAG = 'ppopt-run'

const mobile = () => {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  return nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)
}

export function systemNotifyState(): SystemNotifyState {
  if (!window.isSecureContext || !('Notification' in window) || mobile()) return 'unsupported'
  return Notification.permission
}

/**
 * Ask for permission. Call it straight from the user's gesture (Firefox and Safari insist): the
 * browser is asked before this function first awaits.
 */
export function requestSystemNotify(): Promise<SystemNotifyState> {
  if (systemNotifyState() === 'unsupported') return Promise.resolve('unsupported')
  return new Promise((resolve) => {
    // Older Safari takes a callback and returns nothing.
    const asked = Notification.requestPermission(resolve)
    asked?.then(resolve, () => resolve(Notification.permission))
  })
}

let current: Notification | null = null

/** Show the run's notification, replacing the last one. Never throws. */
export function sendSystemNotice(notice: RunNotice) {
  if (systemNotifyState() !== 'granted') return
  try {
    current?.close()
    const n = new Notification(notice.title, { body: notice.body, tag: TAG })
    n.onclick = () => {
      window.focus() // the tab becomes visible: its mark clears and the pop-up's timer starts
      n.close()
      document.querySelector('.report, .error')?.scrollIntoView?.({ block: 'start' })
    }
    current = n
  } catch {
    current = null // e.g. TypeError where only a service worker may notify
  }
}
