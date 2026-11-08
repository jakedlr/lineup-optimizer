import { vi } from 'vitest'

/**
 * Installs a recording stand-in for the browser's `Notification` as a global and returns it.
 * `answer` is what `requestPermission` resolves to (and the permission it leaves behind).
 */
export function fakeNotification(permission: NotificationPermission, answer: NotificationPermission = permission) {
  class FakeNotification {
    static permission: NotificationPermission = permission
    static made: FakeNotification[] = []
    static throws: Error | null = null
    static requestPermission = vi.fn(async (): Promise<NotificationPermission> => {
      FakeNotification.permission = answer
      return answer
    })

    onclick: ((e: Event) => void) | null = null
    close = vi.fn()
    title: string
    options?: NotificationOptions

    constructor(title: string, options?: NotificationOptions) {
      if (FakeNotification.throws) throw FakeNotification.throws
      this.title = title
      this.options = options
      FakeNotification.made.push(this)
    }
  }
  vi.stubGlobal('Notification', FakeNotification)
  return FakeNotification
}
