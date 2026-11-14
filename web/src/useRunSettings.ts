import { useCallback, useEffect, useRef, useState } from 'react'
import { getOptions, getSettings, message, patchSettings, type Options, type SavedSettings, type ServerSettings } from './api'
import { hasOldRunSettings, load, mergeServer, runChanges, save, toSaved, type Settings } from './settings'

/** How long the run settings must sit still before they're saved, so "2" then "25" is one save. */
export const SAVE_DELAY_MS = 500

const runSettings = ({ sports, stake, hours, devig, ref_slip }: SavedSettings): SavedSettings => ({ sports, stake, hours, devig, ref_slip })
const later = (a: string, b: string) => Date.parse(a) > Date.parse(b)

/**
 * The settings form: run settings from the server, view preferences from this browser. A change is saved once typing
 * pauses, as only the run settings that changed (PATCH), so another tab's change to something else stands. Whatever
 * the server answers with comes into the form, bar the settings being edited here: those are this page's to save.
 * `sync(updatedAt)` hears when the server last saved them (from /api/status) and loads them again if that's news.
 * A browser that saved run settings before they moved to the server copies them across once, when the server has
 * none, and then forgets them.
 */
export function useRunSettings() {
  const [options, setOptions] = useState<Options | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const opts = useRef<Options | null>(null)
  const form = useRef<Settings | null>(null) // the form as it is now
  const held = useRef<SavedSettings | null>(null) // the run settings the server holds, as this page last heard
  const heldAt = useRef<string | null>(null) // ... and when it saved them
  const reloading = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queue = useRef<Promise<unknown>>(Promise.resolve()) // one save at a time, in order
  const live = useRef(true)

  const fill = (s: Settings) => {
    form.current = s
    setSettings(s)
  }

  /** Take what the server answered, unless this page has heard of a later save. */
  const take = useCallback((server: ServerSettings) => {
    if (!opts.current || !form.current) return
    if (heldAt.current && server.updated_at && later(heldAt.current, server.updated_at)) return
    fill(mergeServer(form.current, held.current, server, opts.current))
    held.current = runSettings(server)
    heldAt.current = server.updated_at
  }, [])

  /** What this page has to save: the valid run settings that differ from the server's, or null. */
  const pending = useCallback(() => {
    if (!form.current || !held.current) return null
    const changes = runChanges(form.current, held.current)
    return Object.keys(changes).length ? changes : null
  }, [])

  /** Save what `body()` gives when this save's turn comes; resolves to whether it was saved. */
  const send = useCallback(
    (body: () => Partial<SavedSettings> | null) => {
      const sent = queue.current.then(async () => {
        const changes = body()
        if (!changes) return false
        try {
          take(await patchSettings(changes))
          if (live.current) setSaveError(null)
          return true
        } catch (e) {
          if (live.current) setSaveError(`Couldn't save run settings: ${message(e)}`)
          return false
        }
      })
      queue.current = sent
      return sent
    },
    [take],
  )

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    void send(pending)
  }, [send, pending])

  useEffect(() => {
    // StrictMode mounts twice in dev: only the kept mount acts on what loads (and copies old settings across).
    let mounted = true
    live.current = true
    Promise.all([getOptions(), getSettings()])
      .then(([o, server]) => {
        if (!mounted) return
        opts.current = o
        setOptions(o)
        const local = load(o)
        if (!server.saved && hasOldRunSettings()) {
          held.current = runSettings(server)
          heldAt.current = server.updated_at
          fill(local)
          const copy = toSaved(local)
          void send(() => copy).then((saved) => saved && save(form.current!)) // copied: forget them here
        } else {
          form.current = local
          take(server)
          if (server.saved) save(form.current) // any old run settings here are moot
        }
      })
      .catch((e) => mounted && setLoadError(`Couldn't load run settings: ${message(e)}`))
    // A change still waiting when the page goes away is sent there and then, whatever save is in flight.
    const leaving = () => {
      clearTimeout(timer.current)
      const changes = pending()
      if (changes) patchSettings(changes, true).catch(() => {})
    }
    window.addEventListener('pagehide', leaving)
    return () => {
      mounted = false
      live.current = false
      window.removeEventListener('pagehide', leaving)
      clearTimeout(timer.current)
    }
  }, [send, take, pending])

  const change = useCallback(
    (next: Settings) => {
      fill(next)
      save(next)
      clearTimeout(timer.current)
      if (pending()) timer.current = setTimeout(flush, SAVE_DELAY_MS)
    },
    [flush, pending],
  )

  /** The server last saved the run settings at `updatedAt`: load them again if this page hasn't heard of that. */
  const sync = useCallback(
    (updatedAt: string | null) => {
      if (!updatedAt || !held.current || reloading.current) return
      if (heldAt.current && !later(updatedAt, heldAt.current)) return
      reloading.current = true
      getSettings()
        .then((server) => live.current && take(server))
        .catch(() => {}) // the next look will tell
        .finally(() => {
          reloading.current = false
        })
    },
    [take],
  )

  return { options, settings, change, sync, loadError, saveError }
}
