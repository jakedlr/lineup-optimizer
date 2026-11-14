import { useCallback, useEffect, useState } from 'react'
import { getAlerts, message, patchAlerts, type AlertsPatch, type AlertsView } from './api'
import { alertChanges, fromServer, mergeAlerts, zoneValue, type AlertForm } from './alertForm'
import { useServerSaved } from './useServerSaved'

/** This browser's time zone, the clock alert titles should be in. */
const here = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * The alert settings form (GLOSSARY: Alert, Alert tier), kept in step with the server and other tabs as the run
 * settings are (`useServerSaved`). The first time it opens on a server with no time zone chosen, it gives the server
 * this browser's, so alert titles read in the user's clock; after that the zone is the panel's to change. The access
 * token goes on its own (`setToken`, `clearToken`): the server never sends it back, only `token_set`.
 */
export function useAlertSettings() {
  const [loadError, setLoadError] = useState<string | null>(null)
  const saved = useServerSaved<AlertForm, AlertsView, AlertsPatch>({
    get: getAlerts,
    patch: patchAlerts,
    merge: mergeAlerts,
    changes: alertChanges,
    saveFailed: (e) => `Couldn't save alert settings: ${message(e)}`,
  })
  const { open, hold, fill, now, send } = saved

  useEffect(() => {
    let mounted = true // StrictMode mounts twice in dev: only the kept mount acts on what loads
    getAlerts()
      .then((server) => {
        if (!mounted) return
        const zone = server.timezone === null ? zoneValue(here()) : null
        if (!zone) return open(fromServer(server), server)
        hold(server)
        fill({ ...fromServer(server), timezone: zone })
        void send(() => ({ timezone: zone }), true).then((ok) => {
          // Not taken (a zone the server doesn't know, say): none stays chosen, and UTC stands.
          const form = now()
          if (!ok && mounted && form?.timezone === zone) fill({ ...form, timezone: '' })
        })
      })
      .catch((e) => mounted && setLoadError(`Couldn't load alert settings: ${message(e)}`))
    return () => {
      mounted = false
    }
  }, [open, hold, fill, now, send])

  const setToken = useCallback((token: string) => send(() => ({ token })), [send])
  const clearToken = useCallback(() => send(() => ({ token: '' })), [send])

  return {
    form: saved.form,
    saved: saved.saved,
    change: saved.change,
    flush: saved.flush,
    /** The changes still to save (null when none): after a `flush`, what couldn't be saved. */
    unsaved: saved.pending,
    sync: saved.sync,
    setToken,
    clearToken,
    loadError,
    saveError: saved.saveError,
  }
}

export type AlertSettings = ReturnType<typeof useAlertSettings>
