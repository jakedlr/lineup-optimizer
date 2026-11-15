import { useEffect, useRef, useState } from 'react'
import { elapsed } from './format'
import type { Shown } from './progress'
import { useNow } from './useNow'

interface Props {
  progress: Shown | null
  /** When the run started, as the server says; unknown until the server names the run. */
  startedAt?: string
  /** This page's own run: the card is brought into view as it starts (Run may have been pressed far down the page). */
  reveal?: boolean
}

/**
 * How far the run has got. Until the sportsbook requests are planned (total 0) it is indeterminate: no figure, just
 * how long the run has waited for the board. It holds at 99% until the report arrives.
 */
export function RunProgressBar({ progress, startedAt, reveal }: Props) {
  const [mounted] = useState(() => Date.now())
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!reveal) return
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    card.current?.scrollIntoView?.({ block: 'nearest', behavior: still ? 'auto' : 'smooth' })
  }, []) // once, as the run starts
  const now = useNow(1000)
  const planned = !!progress && progress.total > 0
  const percent = Math.min(progress?.percent ?? 0, 99)
  // The server's start, but never later than this card appeared: a server clock ahead of this one can't hold it at 0:00.
  const server = startedAt ? Date.parse(startedAt) : NaN
  const since = Number.isFinite(server) ? Math.min(server, mounted) : mounted
  return (
    <div className="run-progress" ref={card}>
      <div className="run-progress-head">
        <span>{progress?.step || 'Starting…'}</span>
        {planned && <span className="num">{percent}%</span>}
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label="Run progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={planned ? percent : undefined}
      >
        <div className="bar-fill" style={{ transform: `scaleX(${planned ? percent / 100 : 0})` }} />
      </div>
      <p className="muted small">
        {planned
          ? `${progress.done} of ${progress.total} requests to the sportsbooks`
          : `Waiting for PrizePicks · ${elapsed(Math.max(now, since) - since)}`}
      </p>
    </div>
  )
}
