import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  fetchBoard,
  getBoard,
  getLatest,
  message,
  putAuto,
  putBoard,
  runReport,
  RunFailed,
  watchRun,
  type AlertOutcome,
  type AutoState,
  type BoardInfo,
  type Report,
  type RunHead,
  type StartedBy,
} from './api'
import { AlertNote } from './AlertNote'
import { AlertsPanel } from './AlertsPanel'
import { AutoRunsSwitch } from './AutoRunsSwitch'
import { BoardPanel } from './BoardPanel'
import { clock, minutesSince, runLabel, STALE_MINUTES } from './format'
import { ReportView } from './ReportView'
import { PromoPanel } from './PromoPanel'
import { advance, type Shown } from './progress'
import { RunProgressBar } from './RunProgressBar'
import { RunToast } from './RunToast'
import { count, DEFAULT_TOP, NO_PROMOTION, positive, toRun, type Promotion } from './settings'
import { Segmented } from './Segmented'
import { SettingsPanel } from './SettingsPanel'
import { sendSystemNotice } from './systemNotify'
import { applyTheme, loadTheme, type Theme } from './theme'
import { useRunNotifier } from './useRunNotifier'
import { useAlertSettings } from './useAlertSettings'
import { useRunSettings } from './useRunSettings'
import { useServerStatus, type StatusHandler } from './useServerStatus'

type Engine = 'checking' | 'online' | 'offline'

const ENGINE_LABEL: Record<Engine, string> = {
  checking: 'Checking engine…',
  online: 'Engine online',
  offline: 'Engine offline',
}

function useEngineStatus(): Engine {
  const [engine, setEngine] = useState<Engine>('checking')

  useEffect(() => {
    let live = true
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { status?: string }) => live && setEngine(body.status === 'ok' ? 'online' : 'offline'))
      .catch(() => live && setEngine('offline'))
    return () => {
      live = false
    }
  }, [])

  return engine
}

/** The product's mark: an entry slip with its picks, drawn in ink. */
function SlipMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <path
        d="M6 3.5h16a1.5 1.5 0 0 1 1.5 1.5v6.2a2.8 2.8 0 0 0 0 5.6V23a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 23v-6.2a2.8 2.8 0 0 0 0-5.6V5A1.5 1.5 0 0 1 6 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="m9 9.5 1.6 1.6L13.5 8M9 17.5l1.6 1.6 2.9-3.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 9.5h3.5M16 17.5h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** A run as the server names it. Its id is null only for a run recorded before runs had ids. */
type RunRef = { id: string | null; started_by: StartedBy; started_at: string }

/** The same run: by id, or for a run from before ids, by when it started. */
const same = (a: RunRef, b: RunRef | null | undefined) =>
  !!b && (a.id !== null && b.id !== null ? a.id === b.id : a.started_at === b.started_at)

/** Runs go one at a time, so the server's start times order them. */
const after = (a: RunRef, b: RunRef) => Date.parse(a.started_at) > Date.parse(b.started_at)

/**
 * The run going now as this page follows it: its own (`run` is null until the server names it), or one it watches
 * (an auto run, or a run from another page). `lost` is set when its stream ended before the run's end arrived: the
 * first look at the server asked after `lost.since` says what became of it. `over`: the server said none is going,
 * so it isn't watched again, even while a look still names it.
 */
interface Going {
  own: boolean
  run: RunHead | null
  lost?: { since: number; over: boolean }
}

type Outcome = { report: Report } | { error: string; stopped?: boolean }

/** Why Run is held while a run this page didn't start is going. */
const heldFor = (run: RunHead) =>
  `${run.started_by === 'auto' ? 'Auto run' : 'Run from another page'} going (started ${clock(run.started_at)})…`

/** What the page says of its own run when the server stopped it after this page's stream to it dropped. */
const STOPPED = 'the run was stopped: this page lost its connection to it'

function App() {
  const engine = useEngineStatus()
  const [board, setBoard] = useState<BoardInfo | null | undefined>(undefined)
  const [uploading, setUploading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [going, setGoing] = useState<Going | null>(null)
  const [report, setReport] = useState<{ report: Report; label: string; id: string | null } | null>(null)
  const [failure, setFailure] = useState<{ error: string; label: string; id: string | null } | null>(null)
  // How the latest recorded run's alert went, as the server last said (null while none, or still sending).
  const [latestAlert, setLatestAlert] = useState<{ id: string; alert: AlertOutcome } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const { options, settings, change, sync: syncSettings, loadError, saveError } = useRunSettings()
  const alerts = useAlertSettings()
  const [noCache, setNoCache] = useState(false)
  const [promotion, setPromotion] = useState<Promotion>(NO_PROMOTION)
  const [progress, setProgress] = useState<Shown | null>(null)
  const [auto, setAuto] = useState<AutoState | null>(null)
  const [autoError, setAutoError] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const notifier = useRunNotifier({ onHidden: settings?.notify ? sendSystemNotice : undefined })

  // What the page knows of the server's runs, kept in refs so a status answer is judged against the latest.
  const goingRef = useRef<Going | null>(null)
  const watching = useRef<AbortController | null>(null)
  const shown = useRef<RunRef | null | undefined>(undefined) // the newest run whose end is shown; undefined until opened
  const autoBusy = useRef(false)
  const autoQuietThrough = useRef(0) // status answers asked at or before this were asked before the switch changed

  useEffect(() => applyTheme(theme), [theme])

  const begin = (g: Going | null) => {
    goingRef.current = g
    setGoing(g)
  }

  /** Show how a run ended, marked with how and when it started. */
  const show = useCallback((run: Omit<RunRef, 'id'> & { id?: string | null }, outcome: Outcome) => {
    const label = runLabel(run.started_by, run.started_at)
    const id = run.id ?? null
    if ('report' in outcome) {
      setReport({ report: outcome.report, label, id })
      setFailure(null)
    } else {
      setFailure({ error: outcome.error, label, id })
    }
  }, [])

  const refreshBoard = () =>
    getBoard()
      .then(setBoard)
      .catch(() => {})

  const onStatus = useRef<StatusHandler>(() => {})
  const status = useServerStatus(onStatus)

  /** A run followed here has ended: show it, raise the run notification (not for a stopped run), and look again. */
  const end = (run: RunRef | null, outcome: Outcome) => {
    watching.current = null
    if (run) shown.current = run
    show(run ?? { started_by: 'manual', started_at: new Date().toISOString() }, outcome)
    if ('report' in outcome) notifier.notify({ ok: true, report: outcome.report })
    else if (!outcome.stopped) notifier.notify({ ok: false, error: outcome.error })
    begin(null)
    void refreshBoard() // the run saved the board it fetched
    status.look()
  }

  /**
   * The run's stream ended before the run did: hold Run, and let the next look say what became of it. A dropped stream
   * waits for the next poll (no retrying in a tight loop while the network is down); a run the server says is `over`
   * is looked for at once.
   */
  const lose = (over: boolean) => {
    watching.current = null
    begin({ ...goingRef.current!, lost: { since: status.asked(), over } })
    if (over) status.look()
  }

  /** Watch a run from where it is now to its end: one this page didn't start, or its own after its stream dropped. */
  const attach = (run: RunHead, own: boolean) => {
    const ctrl = new AbortController()
    watching.current = ctrl
    begin({ own, run })
    setProgress(null)
    setRefused(null)
    let watched = run
    const onRun = (h: RunHead) => {
      watched = h
      begin({ own: own && h.id === run.id, run: h }) // a run that began since the look is someone else's
    }
    watchRun({ onRun, onProgress: (p) => setProgress((prev) => advance(prev, p)), onBoard: setBoard }, ctrl.signal)
      .then((next) => {
        if (ctrl.signal.aborted) return
        if (next) end(watched, { report: next })
        else lose(true) // none going any more: the next look finds how it ended
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return
        if (e instanceof RunFailed) end(watched, { error: e.message, stopped: e.stopped })
        else lose(false)
      })
  }

  /** Show the latest run the server recorded, unless a newer one has been shown since it was asked for. */
  const showLatest = (quietly: boolean) =>
    getLatest()
      .then((entry) => {
        if (!entry || !same(entry, shown.current)) return
        show(entry, entry.report ? { report: entry.report } : { error: entry.error })
        if (!quietly) notifier.notify(entry.report ? { ok: true, report: entry.report } : { ok: false, error: entry.error })
      })
      .catch(() => {})

  const handleStatus: StatusHandler = (answer, seq) => {
    if (!autoBusy.current && seq > autoQuietThrough.current) setAuto(answer.auto)
    syncSettings(answer.settings_updated_at)
    alerts.sync(answer.alerts_updated_at)
    const { running, latest } = answer
    const told = latest?.id && latest.alert ? { id: latest.id, alert: latest.alert } : null
    setLatestAlert((was) => (JSON.stringify(was) === JSON.stringify(told) ? was : told))
    const g = goingRef.current
    if (g && !(g.lost && seq > g.lost.since)) return
    setRefused(null) // whatever refused this page's Run has gone, or is about to be watched

    if (g?.run) {
      // Its stream dropped: still going (watch it again), recorded (shown below as news), or stopped by the server.
      if (running && same(running, g.run)) {
        if (!g.lost!.over) attach(running, g.own) // else it's winding up: the next look will say how it ended
        return
      }
      begin(null)
      if (g.own && !(latest && same(latest, g.run))) {
        shown.current = g.run
        show(g.run, { error: STOPPED })
      }
    }

    if (shown.current === undefined) {
      // Opening: the latest run is old news, shown without a notification.
      shown.current = latest
      if (latest) void showLatest(true)
    }
    const isNew = (r: RunRef) => !shown.current || after(r, shown.current)
    if (running && isNew(running)) attach(running, false)
    else if (latest && isNew(latest)) {
      shown.current = latest
      void showLatest(false)
    }
  }
  useEffect(() => {
    onStatus.current = handleStatus
  })

  useEffect(() => () => watching.current?.abort(), []) // leaving stops watching; the run goes on

  useEffect(() => {
    // StrictMode mounts twice in dev: results from the discarded mount are dropped, so only the kept one fetches the
    // board (back-to-back fetches get rate-limited by the partner feed).
    let live = true
    // Every run fetches its own board; this one fills the promo-leg picker when there's no usable board yet.
    const fetchNow = async () => {
      setFetching(true)
      try {
        const fresh = await fetchBoard()
        if (live) setBoard(fresh)
      } catch (e) {
        if (live) setFetchError(message(e))
      } finally {
        if (live) setFetching(false)
      }
    }
    getBoard()
      .catch(() => null)
      .then((saved) => {
        if (!live) return
        setBoard(saved)
        if (!saved || minutesSince(saved.saved_at) > STALE_MINUTES) void fetchNow()
      })
    return () => {
      live = false
    }
  }, [])

  const request = settings ? toRun(settings, noCache, promotion) : null
  const problem = typeof request === 'string' ? request : null
  const held = going && !going.own && going.run ? heldFor(going.run) : null
  // A run fetches the board too; starting one mid-fetch would hit the partner feed right behind this one (HTTP 429).
  const blocked = problem ?? held ?? (fetching ? 'Fetching the board…' : null) ?? refused

  const upload = async (file: File) => {
    setUploading(true)
    setError(null)
    setFailure(null)
    try {
      setBoard(await putBoard(file))
      setFetchError(null) // the upload is the fallback for it
      setReport(null) // a report from the old board no longer matches
      setPromotion((p) => ({ ...p, legs: [] })) // promo legs were picked from the old board
    } catch (e) {
      setError(message(e))
    } finally {
      setUploading(false)
    }
  }

  const run = async () => {
    if (!request || typeof request === 'string' || fetching || goingRef.current) return
    let named: RunHead | null = null // the server names the run as it starts it
    begin({ own: true, run: null })
    setError(null)
    setFailure(null)
    setRefused(null)
    setFetchError(null) // the run fetches again, and its report says if it had to fall back
    setProgress(null)
    const onRun = (h: RunHead) => {
      named = h
      begin({ own: true, run: h })
    }
    try {
      const next = await runReport(request, { onRun, onProgress: (p) => setProgress((prev) => advance(prev, p)), onBoard: setBoard })
      end(named, { report: next })
    } catch (e) {
      if (named && e instanceof RunFailed) end(named, { error: e.message, stopped: e.stopped })
      else if (named) lose(false) // the run may go on without this page
      else {
        // The server never started a run: refused (another got there first: the next look watches it), or the request
        // failed before it could.
        begin(null)
        if (e instanceof ApiError && e.status === 409) setRefused(message(e))
        else {
          setError(message(e))
          notifier.notify({ ok: false, error: message(e) })
        }
        status.look()
      }
    }
  }

  const toggleAuto = () => {
    if (!auto || autoBusy.current) return
    const before = auto
    const enabled = !auto.enabled
    autoBusy.current = true
    setAuto({ ...auto, enabled, next_run_at: null, off_reason: null })
    setAutoError(null)
    putAuto(enabled)
      .then(setAuto)
      .catch((e) => {
        setAuto(before)
        setAutoError(`Couldn't switch auto runs ${enabled ? 'on' : 'off'}: ${message(e)}`)
      })
      .finally(() => {
        autoBusy.current = false
        autoQuietThrough.current = status.asked()
      })
  }

  const autoNote = autoError ?? (auto && !auto.enabled ? auto.off_reason : null)
  /** How the alert of the run shown went, when that run is the latest and the server has said. */
  const alertOf = (id: string | null) => (id !== null && latestAlert?.id === id ? latestAlert.alert : null)
  const failureAlert = failure && alertOf(failure.id)

  return (
    <main className="shell">
      <header className="top">
        <div className="brand">
          <SlipMark />
          <div>
            <h1>PrizePicks EV Optimizer</h1>
          <p className="engine" data-state={engine} role="status">
              {ENGINE_LABEL[engine]}
            </p>
          </div>
        </div>
        <Segmented<Theme>
          label="Theme"
          value={theme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onPick={setTheme}
        />
      </header>

      <BoardPanel
        board={board}
        fetching={fetching}
        fetchError={fetchError}
        uploading={uploading}
        locked={fetching || uploading || !!going}
        appUrl={options?.board_app_url ?? null}
        onFile={upload}
      />

      {options && settings && (
        <>
          <SettingsPanel
            options={options}
            settings={settings}
            onChange={change}
            noCache={noCache}
            onNoCache={setNoCache}
            saveError={saveError}
          />
          <AlertsPanel alerts={alerts} />
          <PromoPanel
            promotion={promotion}
            onChange={setPromotion}
            sports={settings.sports}
            hours={positive(settings.hours)}
            boardKey={board?.saved_at ?? null}
          />
        </>
      )}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!request || !!blocked || !!going || uploading}
          onClick={run}
        >
          {going?.own ? 'Running…' : 'Run'}
        </button>
        {!going?.own && blocked && <span className="warn">{blocked}</span>}
        <AutoRunsSwitch auto={auto} onToggle={toggleAuto} />
      </div>
      {autoNote && <p className="warn small auto-note">{autoNote}</p>}

      {going && <RunProgressBar progress={progress} />}

      {(error ?? loadError) && (
        <p className="error" role="alert">
          {error ?? loadError}
        </p>
      )}

      {failure && (
        <p className="error" role="alert">
          <span className="run-mark">{failure.label}</span> {failure.error}
        </p>
      )}
      {failureAlert && (
        <p className="small alert-line">
          <AlertNote alert={failureAlert} />
        </p>
      )}

      {!report && !going && (
        <section className="empty-report" aria-labelledby="empty-h">
          <h2 id="empty-h">No report yet</h2>
          <p className="muted">
            Run prices every line on the board against FanDuel and DraftKings, then lists the Best Slips, Top Legs and
            anything left unpriced.
          </p>
        </section>
      )}

      {report && settings && (
        <ReportView
          report={report.report}
          label={report.label}
          alert={alertOf(report.id)}
          top={count(settings.top) ?? DEFAULT_TOP}
          slipType={settings.slipType}
          slipSize={settings.slipSize}
          onFilter={(f) => change({ ...settings, ...f })}
        />
      )}

      <RunToast notice={notifier.notice} onClose={notifier.dismiss} />
    </main>
  )
}

export default App
