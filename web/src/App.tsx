import { useEffect, useState } from 'react'
import { getBoard, getOptions, putBoard, runReport, type BoardInfo, type Options, type Report } from './api'
import { BoardPanel } from './BoardPanel'
import { ReportView } from './ReportView'
import { PromoPanel } from './PromoPanel'
import { DEFAULT_TOP, load, NO_PROMOTION, positive, save, toRun, type Promotion, type Settings } from './settings'
import { SettingsPanel } from './SettingsPanel'

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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function App() {
  const engine = useEngineStatus()
  const [board, setBoard] = useState<BoardInfo | null | undefined>(undefined)
  const [uploading, setUploading] = useState(false)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [noCache, setNoCache] = useState(false)
  const [promotion, setPromotion] = useState<Promotion>(NO_PROMOTION)

  useEffect(() => {
    getBoard()
      .then(setBoard)
      .catch(() => setBoard(null))
    getOptions()
      .then((o) => {
        setOptions(o)
        setSettings(load(o))
      })
      .catch((e) => setError(`Couldn't load run settings: ${message(e)}`))
  }, [])

  const change = (next: Settings) => {
    setSettings(next)
    save(next)
  }

  const request = settings ? toRun(settings, noCache, promotion) : null
  const problem = typeof request === 'string' ? request : null

  const upload = async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      setBoard(await putBoard(file))
      setReport(null) // a report from the old board no longer matches
    } catch (e) {
      setError(message(e))
    } finally {
      setUploading(false)
    }
  }

  const run = async () => {
    if (!request || typeof request === 'string') return
    setRunning(true)
    setError(null)
    try {
      setReport(await runReport(request))
    } catch (e) {
      setError(message(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <main className="shell">
      <header className="top">
        <h1>PrizePicks EV Optimizer</h1>
        <p className="engine" data-state={engine} role="status">
          {ENGINE_LABEL[engine]}
        </p>
      </header>

      <BoardPanel board={board} uploading={uploading} onFile={upload} />

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
          disabled={!board || !request || !!problem || running || uploading}
          onClick={run}
        >
          {running ? 'Running…' : 'Run'}
        </button>
        {running ? (
          <span className="muted small">Fetching sportsbook odds. This can take a minute.</span>
        ) : (
          problem && <span className="warn">{problem}</span>
        )}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {report && settings && (
        <ReportView
          report={report}
          top={Math.floor(positive(settings.top) ?? DEFAULT_TOP)}
          slipType={settings.slipType}
          slipSize={settings.slipSize}
          onFilter={(f) => change({ ...settings, ...f })}
        />
      )}
    </main>
  )
}

export default App
