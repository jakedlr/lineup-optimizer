import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { getStatus, type Status } from './api'

export type StatusHandler = (status: Status, seq: number) => void

/** How often the page asks the server what it's doing: often while you look, rarely from a background tab. */
export const POLL_MS = 5000
export const HIDDEN_POLL_MS = 30_000

const hidden = () => document.visibilityState === 'hidden'

/**
 * Polls GET /api/status, handing each answer to `handler.current` with its sequence number: answers are numbered in the
 * order they were asked, so a caller can set aside one asked before something it knows changed (`asked()` is the
 * number of the latest one asked). Looks again at once when the tab comes back into view, and on `look()`.
 */
export function useServerStatus(handler: RefObject<StatusHandler>) {
  const seq = useRef(0)
  const live = useRef(true)

  const look = useCallback(() => {
    const n = ++seq.current
    getStatus()
      .then((s) => live.current && handler.current(s, n))
      .catch(() => {}) // the next look will tell
  }, [handler])

  useEffect(() => {
    live.current = true
    let timer: ReturnType<typeof setInterval> | undefined
    const plan = () => {
      clearInterval(timer)
      timer = setInterval(look, hidden() ? HIDDEN_POLL_MS : POLL_MS)
    }
    const onVisibility = () => {
      if (!hidden()) look()
      plan()
    }
    look()
    plan()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      live.current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [look])

  const asked = useCallback(() => seq.current, [])
  return { look, asked }
}
