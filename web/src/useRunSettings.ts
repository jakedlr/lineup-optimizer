import { useCallback, useEffect, useRef, useState } from 'react'
import { getOptions, getSettings, putSettings, type Options, type SavedSettings } from './api'
import { fromServer, hasOldRunSettings, load, save, toSaved, type Settings } from './settings'

/** How long the run settings must sit still before they're saved, so "2" then "25" is one save. */
export const SAVE_DELAY_MS = 500

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The settings form: run settings from the server (saved there when they change and are valid), view preferences
 * from this browser. A browser that saved run settings before they moved to the server copies them across once,
 * when the server has none, and then forgets them.
 */
export function useRunSettings() {
  const [options, setOptions] = useState<Options | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const held = useRef<string | null>(null) // the run settings the server holds, as JSON
  const pending = useRef<SavedSettings | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queue = useRef<Promise<void>>(Promise.resolve()) // one save at a time, in order
  const live = useRef(true)

  const send = useCallback((body: SavedSettings, keepalive = false) => {
    const key = JSON.stringify(body)
    queue.current = queue.current.then(() =>
      putSettings(body, keepalive)
        .then(() => {
          held.current = key
          if (live.current) setSaveError(null)
        })
        .catch((e) => {
          if (live.current) setSaveError(`Couldn't save run settings: ${message(e)}`)
        }),
    )
    return queue.current
  }, [])

  const flush = useCallback(
    (keepalive = false) => {
      clearTimeout(timer.current)
      const body = pending.current
      pending.current = null
      if (body) void send(body, keepalive)
    },
    [send],
  )

  useEffect(() => {
    // StrictMode mounts twice in dev: only the kept mount acts on what loads (and copies old settings across).
    let mounted = true
    live.current = true
    Promise.all([getOptions(), getSettings()])
      .then(([o, server]) => {
        if (!mounted) return
        const local = load(o)
        const copy = !server.saved && hasOldRunSettings()
        const s = copy ? local : fromServer(server, o, local)
        setOptions(o)
        setSettings(s)
        const body = toSaved(s)
        if (copy && body) {
          void send(body).then(() => held.current === JSON.stringify(body) && save(s)) // copied: forget them here
        } else {
          held.current = JSON.stringify(body)
          if (server.saved) save(s) // any old run settings here are moot
        }
      })
      .catch((e) => mounted && setLoadError(`Couldn't load run settings: ${message(e)}`))
    // A change still waiting when the page goes away is sent anyway.
    const leaving = () => flush(true)
    window.addEventListener('pagehide', leaving)
    return () => {
      mounted = false
      live.current = false
      window.removeEventListener('pagehide', leaving)
      clearTimeout(timer.current)
    }
  }, [send, flush])

  const change = useCallback((next: Settings) => {
    setSettings(next)
    save(next)
    clearTimeout(timer.current)
    const body = toSaved(next)
    pending.current = body && JSON.stringify(body) !== held.current ? body : null
    if (pending.current) timer.current = setTimeout(flush, SAVE_DELAY_MS)
  }, [flush])

  return { options, settings, change, loadError, saveError }
}
