import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { BoardInfo } from './api'
import { ago, minutesSince, STALE_MINUTES } from './format'

interface Props {
  board: BoardInfo | null | undefined // undefined while loading
  fetching: boolean // fetching a board from PrizePicks
  fetchError: string | null // why the last fetch failed
  uploading: boolean
  locked: boolean // while fetching, uploading or running: a new board mid-run would be reported on with the old one's results
  appUrl: string | null // the PrizePicks app's feed, for saving a board by hand
  onFile: (file: File) => void
}

/** Re-render periodically so "fetched N min ago" stays true. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

const PRIZEPICKS = 'https://app.prizepicks.com'
const SOURCE: Record<BoardInfo['source'], string> = { fetched: 'Fetched', uploaded: 'Uploaded' }

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function HowToGetABoard({ appUrl }: { appUrl: string | null }) {
  return (
    <>
      <p className="muted small">
        Runs still try PrizePicks first, and use an uploaded board only while the fetch keeps failing. To save one:
      </p>
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
          {appUrl ? (
            <a href={appUrl} target="_blank" rel="noreferrer" className="break">
              {appUrl.replace('https://', '')}
            </a>
          ) : (
            "the app's projections feed"
          )}{' '}
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
        .json file.
      </p>
    </>
  )
}

export function BoardPanel({ board, fetching, fetchError, uploading, locked, appUrl, onFile }: Props) {
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
  const stale = !!board && age > STALE_MINUTES
  // Open only when there's no usable board, and not while a fetch might still bring one.
  const fallbackOpen = !fetching && (board === null || stale)

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
          fetching ? (
            <p className="muted">Fetching board…</p>
          ) : (
            <p>
              <strong>No board yet.</strong>
            </p>
          )
        ) : (
          <>
            <p>
              <strong>
                {SOURCE[board.source] ?? 'Saved'} {ago(age)}
              </strong>{' '}
              <span className="muted">· {board.projections.toLocaleString('en-US')} lines</span>
            </p>
            {fetching ? (
              <p className="muted">Fetching board…</p>
            ) : (
              stale && <p className="warn">Over {STALE_MINUTES} minutes old, so PrizePicks lines may have moved.</p>
            )}
          </>
        )}
        {fetchError && !fetching && <p className="warn">{sentence(fetchError)}</p>}
      </div>

      {board !== undefined && (
        // keyed on its default so it re-opens when the board stops being usable, but stays wherever the user put it otherwise
        <details className="howto" open={fallbackOpen} key={String(fallbackOpen)}>
          <summary>Board fetch failing? Upload one instead</summary>
          <HowToGetABoard appUrl={appUrl} />
          <button type="button" className="secondary" disabled={locked} onClick={() => input.current?.click()}>
            {uploading ? 'Uploading…' : board ? 'Replace board' : 'Choose file'}
          </button>
        </details>
      )}
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
    </section>
  )
}
