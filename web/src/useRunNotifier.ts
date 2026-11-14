import { useCallback, useEffect, useRef, useState } from 'react'
import { runNotice, type RunNotice, type RunOutcome } from './notify'
import { clearTabMark, markTab } from './tabMark'

/** How long a pop-up stays once it has been seen, not counting while it's held (pointer on it, or focus in it). */
export const DISMISS_MS = 6000
/** How long a pop-up takes to fade out as it goes (index.css `.toast[data-leaving]`). */
export const LEAVE_MS = 150

export interface ShownNotice extends RunNotice {
  /** Changes with every notification, so a replacement mounts (and fades in) afresh. */
  id: number
  /** Fading out: gone LEAVE_MS later. */
  leaving?: boolean
}

export interface RunNotifierOptions {
  /**
   * Called when a run notification is raised while the tab is hidden, after the tab is marked.
   * The seam for system notifications (Story 3): pass a sender gated by the Settings toggle.
   */
  onHidden?: (notice: RunNotice) => void
}

const hidden = () => document.visibilityState === 'hidden'

/**
 * Raises run notifications: one pop-up at a time, dismissed about 6s after it has been seen. While the
 * tab is hidden the pop-up waits, the tab is marked, and `onHidden` fires; coming back clears the mark.
 * `hold(true)` stops the clock while the user is on the pop-up; `hold(false)` gives it the time it had left.
 */
export function useRunNotifier({ onHidden }: RunNotifierOptions = {}) {
  const [notice, setNotice] = useState<ShownNotice | null>(null)
  const [waiting, setWaiting] = useState(false) // raised while hidden and not yet seen
  const [held, setHeld] = useState(false) // the pointer is on it, or focus is in it
  const left = useRef({ id: 0, ms: DISMISS_MS }) // the time the pop-up showing has left
  const nextId = useRef(0)
  const onHiddenRef = useRef(onHidden)
  useEffect(() => {
    onHiddenRef.current = onHidden
  }, [onHidden])

  /** Fade the pop-up out; it goes once it has faded, unless another has replaced it meanwhile. */
  const dismiss = useCallback(() => {
    const id = nextId.current
    setNotice((n) => (n?.id === id && !n.leaving ? { ...n, leaving: true } : n))
    setTimeout(() => setNotice((n) => (n?.id === id ? null : n)), LEAVE_MS)
  }, [])

  const notify = useCallback((outcome: RunOutcome) => {
    const n = runNotice(outcome)
    if (!n) return
    setNotice({ ...n, id: ++nextId.current })
    setHeld(false) // a new pop-up starts its own clock
    if (hidden()) {
      setWaiting(true)
      markTab(n.kind)
      onHiddenRef.current?.(n)
    } else {
      setWaiting(false)
    }
  }, [])

  useEffect(() => {
    const onChange = () => {
      if (hidden()) return
      clearTabMark()
      setWaiting(false)
    }
    document.addEventListener('visibilitychange', onChange)
    return () => {
      document.removeEventListener('visibilitychange', onChange)
      clearTabMark()
    }
  }, [])

  useEffect(() => {
    if (!notice || notice.leaving || waiting || held) return
    if (left.current.id !== notice.id) left.current = { id: notice.id, ms: DISMISS_MS }
    const started = Date.now()
    const timer = setTimeout(dismiss, left.current.ms)
    return () => {
      clearTimeout(timer)
      if (left.current.id === notice.id) left.current.ms = Math.max(0, left.current.ms - (Date.now() - started))
    }
  }, [notice, waiting, held, dismiss])

  return { notice, notify, dismiss, hold: setHeld }
}
