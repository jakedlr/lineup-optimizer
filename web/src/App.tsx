import { useEffect, useState } from 'react'
import { fetchBoard, getBoard, getOptions, putBoard, runReport, type BoardInfo, type Options, type Report } from './api'
import { BoardPanel } from './BoardPanel'
import { minutesSince, STALE_MINUTES } from './format'
import { ReportView } from './ReportView'
import { PromoPanel } from './PromoPanel'
import { advance, type Shown } from './progress'
import { RunProgressBar } from './RunProgressBar'
import { RunToast } from './RunToast'
import { count, DEFAULT_TOP, load, NO_PROMOTION, positive, save, toRun, type Promotion, type Settings } from './settings'
import { Segmented } from './Segmented'
import { SettingsPanel } from './SettingsPanel'
import { sendSystemNotice } from './systemNotify'
import { applyTheme, loadTheme, type Theme } from './theme'
import { useRunNotifier } from './useRunNotifier'

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

function App() {
  const engine = useEngineStatus()
  const [board, setBoard] = useState<BoardInfo | null | undefined>(undefined)
  const [uploading, setUploading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [noCache, setNoCache] = useState(false)
  const [promotion, setPromotion] = useState<Promotion>(NO_PROMOTION)
  const [progress, setProgress] = useState<Shown | null>(null)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const notifier = useRunNotifier({ onHidden: settings?.notify ? sendSystemNotice : undefined })

  useEffect(() => applyTheme(theme), [theme])

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
    getOptions()
      .then((o) => {
        if (!live) return
        setOptions(o)
        setSettings(load(o))
      })
      .catch((e) => live && setError(`Couldn't load run settings: ${message(e)}`))
    return () => {
      live = false
    }
  }, [])

  const change = (next: Settings) => {
    setSettings(next)
    save(next)
  }

  const request = settings ? toRun(settings, noCache, promotion) : null
  const problem = typeof request === 'string' ? request : null
  // A run fetches the board too; starting one mid-fetch would hit the partner feed right behind this one (HTTP 429).
  const blocked = problem ?? (fetching ? 'Fetching the board…' : null)

  const upload = async (file: File) => {
    setUploading(true)
    setError(null)
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
    if (!request || typeof request === 'string' || fetching) return
    setRunning(true)
    setError(null)
    setFetchError(null) // the run fetches again, and its report says if it had to fall back
    setProgress(null)
    try {
      const next = await runReport(request, (p) => setProgress((prev) => advance(prev, p)), setBoard)
      setReport(next)
      notifier.notify({ ok: true, report: next })
    } catch (e) {
      setError(message(e))
      notifier.notify({ ok: false, error: message(e) })
    } finally {
      setRunning(false)
      // The run saved the board it fetched.
      getBoard()
        .then(setBoard)
        .catch(() => {})
    }
  }

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
        locked={fetching || uploading || running}
        appUrl={options?.board_app_url ?? null}
        onFile={upload}
      />

      {options && settings && (
        <>
          <SettingsPanel options={options} settings={settings} onChange={change} noCache={noCache} onNoCache={setNoCache} />
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
          disabled={!request || !!blocked || running || uploading}
          onClick={run}
        >
          {running ? 'Running…' : 'Run'}
        </button>
        {!running && blocked && <span className="warn">{blocked}</span>}
      </div>

      {running && <RunProgressBar progress={progress} />}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!report && !running && (
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
          report={report}
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
