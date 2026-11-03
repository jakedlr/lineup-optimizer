import { useEffect, useState } from 'react'

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

function App() {
  const engine = useEngineStatus()

  return (
    <main className="shell">
      <header>
        <h1>PrizePicks EV Optimizer</h1>
        <p className="engine" data-state={engine} role="status">
          {ENGINE_LABEL[engine]}
        </p>
      </header>
    </main>
  )
}

export default App
