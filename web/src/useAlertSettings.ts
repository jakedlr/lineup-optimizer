import { useCallback, useEffect, useState } from 'react'
import { getAlerts, message, patchAlerts, type AlertsPatch, type AlertsView } from './api'
import { alertChanges, fromServer, mergeAlerts, type AlertForm } from './alertForm'
import { useServerSaved } from './useServerSaved'

/** This browser's time zone, the clock alert titles should be in. */
const here = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * The alert settings form (GLOSSARY: Alert, Alert tier), kept in step with the server and other tabs as the run
 * settings are (`useServerSaved`). On opening, the server is told this browser's time zone if it has another, so
 * alert titles read in the user's clock. The access token goes on its own (`setToken`, `clearToken`): the server
 * never sends it back, only `token_set`.
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
  const { open, send } = saved

  useEffect(() => {
    let mounted = true // StrictMode mounts twice in dev: only the kept mount acts on what loads
    getAlerts()
      .then((server) => {
        if (!mounted) return
        open(fromServer(server), server)
        const zone = here()
        if (zone && zone !== server.timezone) void send(() => ({ timezone: zone }), true) // a zone it doesn't know: UTC stands
      })
      .catch((e) => mounted && setLoadError(`Couldn't load alert settings: ${message(e)}`))
    return () => {
      mounted = false
    }
  }, [open, send])

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
