import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { BoardInfo } from './api'
import { ago, minutesSince, STALE_MINUTES } from './format'

interface Props {
  board: BoardInfo | null | undefined // undefined while loading
  uploading: boolean
  locked: boolean // while uploading or running: a new board mid-run would be reported on with the old one's results
  onFile: (file: File) => void
}

/** Re-render periodically so "saved N min ago" stays true. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

const PRIZEPICKS = 'https://app.prizepicks.com'
const FEED = 'https://api.prizepicks.com/projections?per_page=1000&single_stat=true&game_mode=pickem'

function HowToGetABoard({ open }: { open: boolean }) {
  return (
    // keyed on `open` so it re-opens when the board goes stale, but stays wherever the user put it otherwise
    <details className="howto" open={open} key={String(open)}>
      <summary>How to get a board</summary>
      <ol>
        <li>
          Log in at{' '}
          <a href={PRIZEPICKS} target="_blank" rel="noreferrer">
            app.prizepicks.com
          </a>
          .
        </li>
        <li>
          In the same browser, open{' '}
          <a href={FEED} target="_blank" rel="noreferrer" className="break">
            {FEED.replace('https://', '')}
          </a>{' '}
          and complete the "verify you're human" check if one appears.
        </li>
        <li>
          Press <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd>+<kbd>S</kbd> on a Mac) to save the page as a <code>.json</code> file.
        </li>
        <li>Drop that file on this box, or use {`"Choose file"`} / {`"Replace board"`}.</li>
      </ol>
      <p className="muted small">
        If the page won't load: open DevTools (<kbd>F12</kbd>) on app.prizepicks.com, go to Network, filter for{' '}
        <code>projections</code>, refresh, then right-click the request → Copy → Copy response, and paste it into a
        .json file. Lines move during the day, so save a fresh board before each session.
      </p>
    </details>
  )
}

export function BoardPanel({ board, uploading, locked, onFile }: Props) {
  const now = useNow()
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (locked) return
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }

  const age = board ? minutesSince(board.saved_at, now) : 0

  return (
    <section
      className="board"
      aria-label="Board"
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        e.preventDefault()
        if (!locked) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <div className="board-status">
        {board === undefined ? (
          <p className="muted">Loading board…</p>
        ) : board === null ? (
          <p>
            <strong>No board yet.</strong> <span className="muted">Drop your saved PrizePicks projections JSON here.</span>
          </p>
        ) : (
          <>
            <p>
              <strong>Board saved {ago(age)}</strong>{' '}
              <span className="muted">· {board.projections.toLocaleString('en-US')} lines</span>
            </p>
            {age > STALE_MINUTES && (
              <p className="warn">Over {STALE_MINUTES} minutes old, so PrizePicks lines may have moved. Re-save it from your browser.</p>
            )}
          </>
        )}
      </div>

      <button type="button" className="secondary" disabled={locked} onClick={() => input.current?.click()}>
        {uploading ? 'Uploading…' : board ? 'Replace board' : 'Choose file'}
      </button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        aria-label="Choose board file"
        className="visually-hidden"
        disabled={locked}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ''
        }}
      />

      {board !== undefined && <HowToGetABoard open={board === null || age > STALE_MINUTES} />}
    </section>
  )
}
