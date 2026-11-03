import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { BoardInfo } from './api'
import { ago, minutesSince, STALE_MINUTES } from './format'

interface Props {
  board: BoardInfo | null | undefined // undefined while loading
  uploading: boolean
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

export function BoardPanel({ board, uploading, onFile }: Props) {
  const now = useNow()
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
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
        setDragging(true)
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

      <button type="button" className="secondary" disabled={uploading} onClick={() => input.current?.click()}>
        {uploading ? 'Uploading…' : board ? 'Replace board' : 'Choose file'}
      </button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        aria-label="Choose board file"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ''
        }}
      />
    </section>
  )
}
