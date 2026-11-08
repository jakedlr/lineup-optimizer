import { useCallback, useEffect, useRef, useState } from 'react'
import { runNotice, type RunNotice, type RunOutcome } from './notify'
import { clearTabMark, markTab } from './tabMark'

/** How long a pop-up stays once it has been seen. */
export const DISMISS_MS = 6000

export interface ShownNotice extends RunNotice {
  /** Changes with every notification, so a replacement mounts (and fades in) afresh. */
  id: number
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
 */
export function useRunNotifier({ onHidden }: RunNotifierOptions = {}) {
  const [notice, setNotice] = useState<ShownNotice | null>(null)
  const [waiting, setWaiting] = useState(false) // raised while hidden and not yet seen
  const nextId = useRef(0)
  const onHiddenRef = useRef(onHidden)
  useEffect(() => {
    onHiddenRef.current = onHidden
  }, [onHidden])

  const dismiss = useCallback(() => setNotice(null), [])

  const notify = useCallback((outcome: RunOutcome) => {
    const n = runNotice(outcome)
    if (!n) return
    setNotice({ ...n, id: ++nextId.current })
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
    if (!notice || waiting) return
    const timer = setTimeout(dismiss, DISMISS_MS)
    return () => clearTimeout(timer)
  }, [notice, waiting, dismiss])

  return { notice, notify, dismiss }
}
