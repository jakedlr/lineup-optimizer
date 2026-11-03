import { useEffect, useState } from 'react'
import { getBoard, putBoard, runReport, type BoardInfo, type Report } from './api'
import { BoardPanel } from './BoardPanel'
import { ReportView } from './ReportView'

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

  useEffect(() => {
    getBoard()
      .then(setBoard)
      .catch(() => setBoard(null))
  }, [])

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
    setRunning(true)
    setError(null)
    try {
      setReport(await runReport())
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

      <div className="actions">
        <button type="button" className="primary" disabled={!board || running || uploading} onClick={run}>
          {running ? 'Running…' : 'Run'}
        </button>
        {running && <span className="muted small">Fetching sportsbook odds. This can take a minute.</span>}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {report && <ReportView report={report} />}
    </main>
  )
}

export default App
