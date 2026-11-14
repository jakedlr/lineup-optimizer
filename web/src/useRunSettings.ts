import { useCallback, useEffect, useRef, useState } from 'react'
import { getOptions, getSettings, message, patchSettings, type Options, type SavedSettings, type ServerSettings } from './api'
import { hasOldRunSettings, load, mergeServer, runChanges, save, toSaved, type Settings } from './settings'
import { useServerSaved } from './useServerSaved'

/**
 * The settings form: run settings from the server (kept in step with it by `useServerSaved`), view preferences from
 * this browser. `sync(updatedAt)` hears when the server last saved the run settings (from /api/status).
 * A browser that saved run settings before they moved to the server copies them across once, when the server has
 * none, and then forgets them.
 */
export function useRunSettings() {
  const [options, setOptions] = useState<Options | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const opts = useRef<Options | null>(null)
  const saved = useServerSaved<Settings, ServerSettings, Partial<SavedSettings>>({
    get: getSettings,
    patch: patchSettings,
    merge: (form, before, server) => mergeServer(form, before, server, opts.current!),
    changes: (form, held) => {
      const changes = runChanges(form, held)
      return Object.keys(changes).length ? changes : null
    },
    saveFailed: (e) => `Couldn't save run settings: ${message(e)}`,
  })
  const { open, hold, fill, send, now } = saved

  useEffect(() => {
    // StrictMode mounts twice in dev: only the kept mount acts on what loads (and copies old settings across).
    let mounted = true
    Promise.all([getOptions(), getSettings()])
      .then(([o, server]) => {
        if (!mounted) return
        opts.current = o
        setOptions(o)
        const local = load(o)
        if (!server.saved && hasOldRunSettings()) {
          hold(server)
          fill(local)
          const copy = toSaved(local)
          void send(() => copy).then((ok) => ok && save(now()!)) // copied: forget them here
        } else {
          open(local, server)
          if (server.saved) save(now()!) // any old run settings here are moot
        }
      })
      .catch((e) => mounted && setLoadError(`Couldn't load run settings: ${message(e)}`))
    return () => {
      mounted = false
    }
  }, [open, hold, fill, send, now])

  const { change: changeSaved } = saved
  const change = useCallback(
    (next: Settings) => {
      save(next) // view preferences: kept in this browser at once
      changeSaved(next)
    },
    [changeSaved],
  )

  return {
    options,
    settings: saved.form,
    change,
    sync: saved.sync,
    loadError,
    saveError: saved.saveError,
    /** When the server last saved the run settings, as this page last heard (null: never). */
    savedAt: saved.saved?.updated_at ?? null,
  }
}
