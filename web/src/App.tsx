import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  fetchBoard,
  getBoard,
  getLatest,
  putAuto,
  putBoard,
  runReport,
  watchRun,
  type AutoState,
  type BoardInfo,
  type Report,
  type StartedBy,
} from './api'
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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The run going now: this page's own, or one it watches (an auto run, or a run from another page). */
interface Going {
  own: boolean
  startedBy: StartedBy
  startedAt: string
}

/** Why Run is held while a run this page didn't start is going. */
const heldFor = (g: Going) =>
  `${g.startedBy === 'auto' ? 'Auto run' : 'Run from another page'} going (started ${clock(g.startedAt)})…`

function App() {
  const engine = useEngineStatus()
  const [board, setBoard] = useState<BoardInfo | null | undefined>(undefined)
  const [uploading, setUploading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [going, setGoing] = useState<Going | null>(null)
  const [report, setReport] = useState<{ report: Report; label: string } | null>(null)
  const [failure, setFailure] = useState<{ error: string; label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const { options, settings, change, loadError, saveError } = useRunSettings()
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
  const watched = useRef<string | null>(null) // started_at of the last run watched: never attached to twice
  const watchedEnd = useRef<string | null>(null) // ... once its end has been shown
  const knownLatest = useRef<string | null | undefined>(undefined) // the latest run's started_at; undefined until opened
  const openingFailed = useRef(false)
  const ownEnded = useRef(false) // this page's run ended: the next latest run recorded may be it
  const quietThrough = useRef(0) // status answers asked at or before this were asked before a run here ended
  const autoBusy = useRef(false)
  const autoQuietThrough = useRef(0) // ... or before the switch last changed

  useEffect(() => applyTheme(theme), [theme])

  const begin = (g: Going | null) => {
    goingRef.current = g
    setGoing(g)
  }

  /** Show how a run ended, marked with how and when it started. */
  const show = useCallback((startedBy: StartedBy, startedAt: string, outcome: { report?: Report; error?: string }) => {
    const label = runLabel(startedBy, startedAt)
    if (outcome.report) {
      setReport({ report: outcome.report, label })
      setFailure(null)
    } else {
      setFailure({ error: outcome.error ?? 'The run failed.', label })
    }
  }, [])

  const refreshBoard = () =>
    getBoard()
      .then(setBoard)
      .catch(() => {})

  const onStatus = useRef<StatusHandler>(() => {})
  const status = useServerStatus(onStatus)

  /** Watch a run this page didn't start, from where it is now to its end, as if it were this page's own. */
  const attach = (startedBy: StartedBy, startedAt: string) => {
    watched.current = startedAt
    const ctrl = new AbortController()
    watching.current = ctrl
    begin({ own: false, startedBy, startedAt })
    setProgress(null)
    setRefused(null)
    watchRun((p) => setProgress((prev) => advance(prev, p)), setBoard, ctrl.signal)
      .then((next) => {
        if (ctrl.signal.aborted || !next) return // none going any more: the next look finds how it ended
        watchedEnd.current = startedAt
        show(startedBy, startedAt, { report: next })
        notifier.notify({ ok: true, report: next })
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return
        watchedEnd.current = startedAt
        show(startedBy, startedAt, { error: message(e) })
        notifier.notify({ ok: false, error: message(e) })
      })
      .finally(() => {
        if (ctrl.signal.aborted) return
        watching.current = null
        quietThrough.current = status.asked()
        begin(null)
        void refreshBoard()
        status.look()
      })
  }

  const handleStatus: StatusHandler = (answer, seq) => {
    if (!autoBusy.current && seq > autoQuietThrough.current) setAuto(answer.auto)
    if (goingRef.current || seq <= quietThrough.current) return

    const running = answer.running
    if (running && running.started_at !== watched.current) {
      attach(running.started_by, running.started_at)
      return
    }

    // A run recorded since this page last looked: this page's own, or one that started and ended between looks.
    const latest = answer.latest?.started_at ?? null
    if (knownLatest.current === undefined) {
      if (openingFailed.current) knownLatest.current = latest
      return
    }
    const mine = ownEnded.current
    ownEnded.current = false
    if (latest === knownLatest.current) return
    knownLatest.current = latest
    if (mine || latest === null || latest === watchedEnd.current) return
    getLatest()
      .then((entry) => {
        if (!entry || goingRef.current || entry.started_at !== knownLatest.current) return
        show(entry.started_by, entry.started_at, entry)
        notifier.notify(entry.report ? { ok: true, report: entry.report } : { ok: false, error: entry.error })
      })
      .catch(() => {})
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
    // The latest run's report (or failure), from whenever it ran: an auto run while the page was closed, say.
    getLatest()
      .then((entry) => {
        if (!live) return
        knownLatest.current = entry?.started_at ?? null
        if (entry && !goingRef.current) show(entry.started_by, entry.started_at, entry)
      })
      .catch(() => {
        openingFailed.current = true
      })
    return () => {
      live = false
    }
  }, [show])

  const request = settings ? toRun(settings, noCache, promotion) : null
  const problem = typeof request === 'string' ? request : null
  const held = going && !going.own ? heldFor(going) : null
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
    const startedAt = new Date().toISOString()
    begin({ own: true, startedBy: 'manual', startedAt })
    setError(null)
    setFailure(null)
    setRefused(null)
    setFetchError(null) // the run fetches again, and its report says if it had to fall back
    setProgress(null)
    let wasRefused = false
    try {
      const next = await runReport(request, (p) => setProgress((prev) => advance(prev, p)), setBoard)
      show('manual', startedAt, { report: next })
      notifier.notify({ ok: true, report: next })
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        wasRefused = true // another run got there first: watch it instead
        setRefused(message(e))
      } else {
        show('manual', startedAt, { error: message(e) })
        notifier.notify({ ok: false, error: message(e) })
      }
    } finally {
      quietThrough.current = status.asked()
      ownEnded.current = !wasRefused
      begin(null)
      if (!wasRefused) void refreshBoard() // the run saved the board it fetched
      status.look()
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
