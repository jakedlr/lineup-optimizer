import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLOCKED_NOTE, requestSystemNotify, sendSystemNotice, systemNotifyState, UNSUPPORTED_NOTE } from './systemNotify'
import { fakeNotification } from './test/fakeNotification'

const notice = { kind: 'finished' as const, title: 'Run finished', body: '2 slips · best +12.3% EV (Power 2)' }

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (navigator as unknown as Record<string, unknown>).userAgent
})

describe('systemNotifyState', () => {
  it('follows the permission on a secure desktop browser', () => {
    const N = fakeNotification('default')
    expect(systemNotifyState()).toBe('default')
    N.permission = 'granted'
    expect(systemNotifyState()).toBe('granted')
    N.permission = 'denied'
    expect(systemNotifyState()).toBe('denied')
  })

  it('is unsupported outside a secure context', () => {
    fakeNotification('granted')
    vi.stubGlobal('isSecureContext', false)
    expect(systemNotifyState()).toBe('unsupported')
  })

  it('is unsupported without the Notification API', () => {
    expect('Notification' in window).toBe(false)
    expect(systemNotifyState()).toBe('unsupported')
  })

  it('is unsupported on a mobile browser, where the constructor throws', () => {
    fakeNotification('granted')
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
    })
    expect(systemNotifyState()).toBe('unsupported')
  })

  it('has a reason for each state that disables the toggle', () => {
    expect(UNSUPPORTED_NOTE).toBe('Needs a desktop browser on localhost or HTTPS')
    expect(BLOCKED_NOTE).toBe('Notifications are blocked for this site in your browser')
  })
})

describe('requestSystemNotify', () => {
  it('asks the browser and returns its answer', async () => {
    const N = fakeNotification('default', 'denied')
    await expect(requestSystemNotify()).resolves.toBe('denied')
    expect(N.requestPermission).toHaveBeenCalledOnce()
  })

  it('handles the old callback-only form', async () => {
    const N = fakeNotification('default')
    N.requestPermission = vi.fn((cb?: (p: NotificationPermission) => void) => {
      cb?.('granted')
      return undefined as unknown as Promise<NotificationPermission>
    })
    await expect(requestSystemNotify()).resolves.toBe('granted')
  })

  it('is unsupported where notifications cannot work', async () => {
    await expect(requestSystemNotify()).resolves.toBe('unsupported')
  })
})

describe('sendSystemNotice', () => {
  it('shows one notification with the title, body and tag', () => {
    const N = fakeNotification('granted')
    sendSystemNotice(notice)
    expect(N.made).toHaveLength(1)
    expect(N.made[0].title).toBe('Run finished')
    expect(N.made[0].options).toEqual({ body: notice.body, tag: 'ppopt-run' })
  })

  it('keeps one at a time: the previous one is closed first', () => {
    const N = fakeNotification('granted')
    sendSystemNotice(notice)
    sendSystemNotice({ ...notice, kind: 'failed', title: 'Run failed', body: 'books down' })
    expect(N.made).toHaveLength(2)
    expect(N.made[0].close).toHaveBeenCalled()
    expect(N.made[1].close).not.toHaveBeenCalled()
  })

  it('sends nothing without permission', () => {
    const N = fakeNotification('default')
    sendSystemNotice(notice)
    expect(N.made).toHaveLength(0)
  })

  it('sends nothing where unsupported', () => {
    const N = fakeNotification('granted')
    vi.stubGlobal('isSecureContext', false)
    sendSystemNotice(notice)
    expect(N.made).toHaveLength(0)
  })

  it('swallows a constructor that throws', () => {
    const N = fakeNotification('granted')
    N.throws = new TypeError('Illegal constructor')
    expect(() => sendSystemNotice(notice)).not.toThrow()
  })

  it('focuses the tab, closes itself and shows the report when clicked', () => {
    const N = fakeNotification('granted')
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    document.body.innerHTML = '<div class="report"></div>'
    const scroll = vi.fn()
    document.querySelector<HTMLElement>('.report')!.scrollIntoView = scroll
    sendSystemNotice(notice)
    N.made[0].onclick?.(new Event('click'))
    expect(focus).toHaveBeenCalled()
    expect(N.made[0].close).toHaveBeenCalled()
    expect(scroll).toHaveBeenCalled()
    document.body.innerHTML = ''
  })
})
