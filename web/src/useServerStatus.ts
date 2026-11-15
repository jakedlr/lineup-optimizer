import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { getStatus, type Status } from './api'

export type StatusHandler = (status: Status, seq: number) => void

/** How often the page asks the server what it's doing: often while you look, rarely from a background tab. */
export const POLL_MS = 5000
export const HIDDEN_POLL_MS = 30_000
/** Looks in a row that may go unanswered before the engine is called offline: one is a blip. */
export const MISSES_OFFLINE = 2

/** Whether the engine answers: not known until the first look does. */
export type Engine = 'checking' | 'online' | 'offline'

const hidden = () => document.visibilityState === 'hidden'

/**
 * Polls GET /api/status, handing each answer to `handler.current` with its sequence number: answers are numbered in the
 * order they were asked, so a caller can set aside one asked before something it knows changed (`asked()` is the
 * number of the latest one asked). Looks again at once when the tab comes back into view, and on `look()`.
 * `engine` says whether the engine answers: offline after MISSES_OFFLINE looks in a row went unanswered, online again
 * at the next answer. `missed`: some look has gone unanswered since the page opened. An error the handler throws is
 * logged, not taken for a missed look.
 */
export function useServerStatus(handler: RefObject<StatusHandler>) {
  const seq = useRef(0)
  const live = useRef(true)
  const misses = useRef(0)
  const [engine, setEngine] = useState<Engine>('checking')
  const [missed, setMissed] = useState(false)

  const look = useCallback(() => {
    const n = ++seq.current
    getStatus()
      .then(
        (s) => {
          if (!live.current) return
          misses.current = 0
          setEngine('online')
          handler.current(s, n)
        },
        () => {
          // unanswered: the next look will tell
          if (!live.current) return
          setMissed(true)
          if (++misses.current >= MISSES_OFFLINE) setEngine('offline')
        },
      )
      .catch((e) => console.error(e)) // the handler threw: a bug here, not the engine gone
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
  return { look, asked, engine, missed }
}
