import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeServer, routes } from './test/fixtures'
import { MISSES_OFFLINE, useServerStatus, type StatusHandler } from './useServerStatus'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useServerStatus', () => {
  // Sprint 11 review: a throw in the handler was swallowed, so a bug there went unseen.
  it("reports an error thrown by the handler to the console, and doesn't count it as a missed look", async () => {
    vi.stubGlobal('fetch', vi.fn(routes(fakeServer().routes)))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bug = new Error('handler bug')
    const handler = { current: vi.fn<StatusHandler>(() => { throw bug }) }
    const { result } = renderHook(() => useServerStatus(handler))
    await waitFor(() => expect(logged).toHaveBeenCalledWith(bug))
    for (let i = 0; i < MISSES_OFFLINE; i++) {
      act(() => result.current.look())
      await waitFor(() => expect(handler.current).toHaveBeenCalledTimes(i + 2))
    }
    expect(result.current.engine).toBe('online')
    expect(result.current.missed).toBe(false)
  })

  it('says once a look has gone unanswered, before the engine is called offline', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('network down'))))
    const handler = { current: () => {} }
    const { result } = renderHook(() => useServerStatus(handler))
    expect(result.current.missed).toBe(false)
    await waitFor(() => expect(result.current.missed).toBe(true))
    expect(result.current.engine).toBe('checking') // one miss is a blip
  })
})
