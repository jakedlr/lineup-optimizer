import { useCallback, useEffect, useRef, useState } from 'react'

/** How long a form must sit still before it's saved, so "2" then "25" is one save. */
export const SAVE_DELAY_MS = 500

const later = (a: string, b: string) => Date.parse(a) > Date.parse(b)

/** What the server holds, as it answers: with when it last saved it. */
interface Held {
  updated_at: string | null
}

/** How one set of settings is kept on the server. `F` is the form, `S` what the server answers, `P` a change. */
export interface ServerSaved<F, S extends Held, P> {
  get: () => Promise<S>
  patch: (changes: P, keepalive: boolean) => Promise<S>
  /** `form` with what the server now holds, except what was edited here away from `before`; all of it when null. */
  merge: (form: F, before: S | null, server: S) => F
  /** The valid parts of `form` that differ from what the server holds, as a PATCH sends them; null when none. */
  changes: (form: F, held: S) => P | null
  /** The words for a save that failed. */
  saveFailed: (e: unknown) => string
}

/**
 * A form whose settings live on the server, shared by every tab (run settings, alert settings). A change is saved
 * once typing pauses, as only the valid parts that changed (PATCH), so another tab's change to something else stands.
 * Whatever the server answers with comes into the form, bar what's being edited here: that is this page's to save.
 * Saves go one at a time, in order. `sync(updatedAt)` hears when the server last saved them (from /api/status) and
 * loads them again if that's news. A change still waiting when the page goes away is sent there and then.
 *
 * The caller loads them: `open(form, server)` fills the form from what the server answered, or `hold(server)` and
 * `fill(form)` when the form should stand as it is (and be saved with `send`).
 */
export function useServerSaved<F, S extends Held, P>(spec: ServerSaved<F, S, P>) {
  const [form, setForm] = useState<F | null>(null)
  const [saved, setSaved] = useState<S | null>(null) // what the server holds, for showing
  const [saveError, setSaveError] = useState<string | null>(null)
  const how = useRef(spec)
  const current = useRef<F | null>(null) // the form as it is now
  const held = useRef<S | null>(null) // what the server holds, as this page last heard
  const heldAt = useRef<string | null>(null) // ... and when it saved it
  const reloading = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queue = useRef<Promise<unknown>>(Promise.resolve()) // one save at a time, in order
  const live = useRef(true)

  useEffect(() => {
    how.current = spec
  })

  const fill = useCallback((f: F) => {
    current.current = f
    setForm(f)
  }, [])

  const hold = useCallback((server: S) => {
    held.current = server
    heldAt.current = server.updated_at
    setSaved(server)
  }, [])

  /** Take what the server answered, unless this page has heard of a later save. */
  const take = useCallback(
    (server: S) => {
      if (!current.current) return
      if (heldAt.current && server.updated_at && later(heldAt.current, server.updated_at)) return
      fill(how.current.merge(current.current, held.current, server))
      hold(server)
    },
    [fill, hold],
  )

  const open = useCallback(
    (f: F, server: S) => {
      current.current = f
      take(server)
    },
    [take],
  )

  /** What this page has to save, or null. */
  const pending = useCallback(
    () => (current.current && held.current ? how.current.changes(current.current, held.current) : null),
    [],
  )

  /** Save what `body()` gives when this save's turn comes; resolves to whether it was saved. A quiet save that fails
   * says nothing. */
  const send = useCallback(
    (body: () => P | null, quiet = false) => {
      const saved = queue.current.then(async () => {
        const changes = body()
        if (!changes) return false
        try {
          take(await how.current.patch(changes, false))
          if (live.current && !quiet) setSaveError(null)
          return true
        } catch (e) {
          if (live.current && !quiet) setSaveError(how.current.saveFailed(e))
          return false
        }
      })
      queue.current = saved
      return saved
    },
    [take],
  )

  /** Save what's waiting now; resolves once it (and every save before it) has been answered. */
  const flush = useCallback(() => {
    clearTimeout(timer.current)
    return send(pending)
  }, [send, pending])

  useEffect(() => {
    live.current = true
    // A change still waiting when the page goes away is sent there and then, whatever save is in flight.
    const leaving = () => {
      clearTimeout(timer.current)
      const changes = pending()
      if (changes) how.current.patch(changes, true).catch(() => {})
    }
    window.addEventListener('pagehide', leaving)
    return () => {
      live.current = false
      window.removeEventListener('pagehide', leaving)
      clearTimeout(timer.current)
    }
  }, [pending])

  const change = useCallback(
    (next: F) => {
      fill(next)
      clearTimeout(timer.current)
      if (pending()) timer.current = setTimeout(flush, SAVE_DELAY_MS)
    },
    [fill, flush, pending],
  )

  /** The server last saved them at `updatedAt`: load them again if this page hasn't heard of that. */
  const sync = useCallback(
    (updatedAt: string | null | undefined) => {
      if (!updatedAt || !held.current || reloading.current) return
      if (heldAt.current && !later(updatedAt, heldAt.current)) return
      reloading.current = true
      how.current
        .get()
        .then((server) => live.current && take(server))
        .catch(() => {}) // the next look will tell
        .finally(() => {
          reloading.current = false
        })
    },
    [take],
  )

  /** The form as it is now, between renders. */
  const now = useCallback(() => current.current, [])

  return { form, saved, open, hold, fill, send, flush, pending, change, sync, now, saveError }
}
