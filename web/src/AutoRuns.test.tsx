import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { controlledRun, fakeServer, localTime, options, report, routes } from './test/fixtures'
import { fakeNotification } from './test/fakeNotification'

// Sprint 9: run settings, auto runs and the latest run live on the server (docs/adr/0003-server-side-auto-runs.md).

const board = () => Response.json({ saved_at: new Date().toISOString(), projections: 11, source: 'fetched' })
let server: ReturnType<typeof fakeServer>

function stub(table: Parameters<typeof routes>[0] = {}) {
  const fn = vi.fn(
    routes({
      ...server.routes,
      'GET /api/health': () => Response.json({ status: 'ok' }),
      'GET /api/options': () => Response.json(options),
      'GET /api/board': board,
      'POST /api/run': () => Response.json(report),
      ...table,
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

const calls = (f: ReturnType<typeof stub>, key: string) =>
  f.mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key)

let visibility: DocumentVisibilityState = 'visible'
function setVisibility(v: DocumentVisibilityState) {
  visibility = v
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

beforeEach(() => {
  server = fakeServer()
  server.state.settings = { ...options.defaults, saved: true }
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const runButton = () => screen.getByRole('button', { name: /^run/i })
const autoSwitch = () => screen.getByRole('switch', { name: /auto runs/i })
const toasts = () => screen.getByRole('status', { name: /run notifications/i })

describe('Latest report on opening', () => {
  it("shows the server's latest report, marked as the auto run it came from", async () => {
    server.state.latest = { started_by: 'auto', started_at: localTime(14, 15), finished_at: localTime(14, 16), report }
    stub()
    render(<App />)
    expect(await screen.findByRole('region', { name: /best slips/i })).toBeInTheDocument()
    expect(screen.getByText('Auto run · 14:15')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /no report yet/i })).not.toBeInTheDocument()
    expect(within(toasts()).queryByText(/run finished/i)).not.toBeInTheDocument() // old news: no notification
  })

  it('shows a latest run that failed, marked as a manual run', async () => {
    server.state.latest = { started_by: 'manual', started_at: localTime(14, 8), finished_at: localTime(14, 9), error: 'no sportsbook odds available' }
    stub()
    render(<App />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('no sportsbook odds available')
    expect(screen.getByText('Run · 14:08')).toBeInTheDocument()
  })

  it("a new run's report replaces it, with the new run's mark", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(new Date().setHours(16, 42, 0, 0)) })
    server.state.latest = { started_by: 'auto', started_at: localTime(14, 15), finished_at: localTime(14, 16), report }
    stub({ 'POST /api/run': () => Response.json({ ...report, settings: { ...report.settings, stake: 33 } }) })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await screen.findByText('Auto run · 14:15')
    await user.click(runButton())
    expect(await screen.findByText(/\$33 stake · cash/)).toBeInTheDocument()
    expect(screen.getByText('Run · 16:42')).toBeInTheDocument()
    expect(screen.queryByText('Auto run · 14:15')).not.toBeInTheDocument()
  })
})

describe('Auto runs switch', () => {
  it('is an off switch until switched on, then names the next run', async () => {
    const fetchMock = stub()
    render(<App />)
    await waitFor(() => expect(autoSwitch()).toBeEnabled())
    expect(autoSwitch()).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText(/next run/i)).not.toBeInTheDocument()

    await userEvent.click(autoSwitch())
    expect(autoSwitch()).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByText('Next run 14:30')).toBeInTheDocument()
    expect(calls(fetchMock, 'PUT /api/auto').map(([, init]) => JSON.parse(String(init!.body)))).toEqual([{ enabled: true }])

    await userEvent.click(autoSwitch())
    await waitFor(() => expect(autoSwitch()).toHaveAttribute('aria-checked', 'false'))
    expect(screen.queryByText(/next run/i)).not.toBeInTheDocument()
  })

  it('opens on as the server has it, and works from the keyboard', async () => {
    server.state.auto = { enabled: true, next_run_at: localTime(9, 45), off_reason: null }
    stub()
    render(<App />)
    expect(await screen.findByText('Next run 09:45')).toBeInTheDocument()
    expect(autoSwitch()).toHaveAttribute('aria-checked', 'true')
    autoSwitch().focus()
    await userEvent.keyboard(' ')
    await waitFor(() => expect(autoSwitch()).toHaveAttribute('aria-checked', 'false'))
    expect(server.state.auto.enabled).toBe(false)
  })

  it('goes back and says why when the server refuses', async () => {
    stub({ 'PUT /api/auto': () => Response.json({ detail: 'disk full' }, { status: 500 }) })
    render(<App />)
    await waitFor(() => expect(autoSwitch()).toBeEnabled())
    await userEvent.click(autoSwitch())
    expect(await screen.findByText(/couldn't switch auto runs on: disk full/i)).toBeInTheDocument()
    expect(autoSwitch()).toHaveAttribute('aria-checked', 'false')
  })

  it('shows why auto runs were switched off', async () => {
    const reason = "the board couldn't be fetched from PrizePicks' partner feed (HTTP 503), so auto runs were switched off"
    server.state.auto = { enabled: false, next_run_at: null, off_reason: reason }
    stub()
    render(<App />)
    expect(await screen.findByText(reason)).toBeInTheDocument()
    expect(autoSwitch()).toHaveAttribute('aria-checked', 'false')
  })

  it('shows a change made elsewhere within one poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stub()
    render(<App />)
    await waitFor(() => expect(autoSwitch()).toBeEnabled())
    server.state.auto = { enabled: true, next_run_at: localTime(10, 0), off_reason: null } // another tab switched them on
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(await screen.findByText('Next run 10:00')).toBeInTheDocument()
    expect(autoSwitch()).toHaveAttribute('aria-checked', 'true')

    server.state.auto = { enabled: false, next_run_at: null, off_reason: 'the board fetch failed, so auto runs were switched off' }
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(await screen.findByText(/so auto runs were switched off/)).toBeInTheDocument()
    expect(autoSwitch()).toHaveAttribute('aria-checked', 'false')
  })
})

describe('Watching a run this page did not start', () => {
  function autoRunGoing(at = localTime(14, 15)) {
    const run = controlledRun()
    server.state.running = { started_by: 'auto', started_at: at }
    server.state.live = run.response
    return run
  }

  function ends(run: ReturnType<typeof controlledRun>, event: object, at = localTime(14, 15)) {
    server.state.running = null
    server.state.latest = { started_by: 'auto', started_at: at, finished_at: at, ...('report' in event ? { report } : { error: 'x' }) }
    run.event(event)
    run.close()
  }

  it('holds Run, shows its progress and board, then its report, and raises the run notification', async () => {
    const run = autoRunGoing()
    const fetchMock = stub()
    render(<App />)
    expect(await screen.findByText(/auto run going/i)).toBeInTheDocument()
    expect(runButton()).toBeDisabled()
    expect(screen.getByRole('progressbar', { name: /run progress/i })).toBeInTheDocument()

    run.event({ type: 'progress', done: 3, total: 10, step: 'DraftKings NBA' })
    await screen.findByText('30%')
    run.event({ type: 'board', board: { saved_at: new Date().toISOString(), projections: 30253, source: 'fetched' } })
    expect(await screen.findByText(/30,253 lines/)).toBeInTheDocument()

    ends(run, { type: 'report', report })
    expect(await screen.findByRole('region', { name: /best slips/i })).toBeInTheDocument()
    expect(screen.getByText('Auto run · 14:15')).toBeInTheDocument()
    expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    await waitFor(() => expect(runButton()).toBeEnabled())
    expect(screen.queryByText(/auto run going/i)).not.toBeInTheDocument()
    expect(calls(fetchMock, 'GET /api/run/live')).toHaveLength(1)
  })

  it('sends a system notification for it while the tab is hidden', async () => {
    vi.stubGlobal('isSecureContext', true)
    const N = fakeNotification('granted')
    localStorage.setItem('ppopt.settings.v1', JSON.stringify({ notify: true }))
    const run = autoRunGoing()
    stub()
    render(<App />)
    await screen.findByText(/auto run going/i)
    setVisibility('hidden')
    ends(run, { type: 'report', report })
    await waitFor(() => expect(N.made).toHaveLength(1))
    expect(N.made[0].title).toBe('Run finished')
  })

  it('shows a run that fails, with its mark and a notification', async () => {
    const run = autoRunGoing()
    stub()
    render(<App />)
    await screen.findByText(/auto run going/i)
    ends(run, { type: 'error', detail: "the board couldn't be fetched, so auto runs were switched off" })
    expect(await screen.findByRole('alert')).toHaveTextContent(/so auto runs were switched off/)
    expect(screen.getByText('Auto run · 14:15')).toBeInTheDocument()
    expect(within(toasts()).getByText('Run failed')).toBeInTheDocument()
  })

  it('attaches once per run, however many polls see it going, and not again after it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const run = autoRunGoing()
    const fetchMock = stub()
    render(<App />)
    await screen.findByText(/auto run going/i)
    await act(() => vi.advanceTimersByTimeAsync(15_000))
    expect(calls(fetchMock, 'GET /api/run/live')).toHaveLength(1)

    run.event({ type: 'report', report }) // the server still says it's going for a moment
    run.close()
    await screen.findByText('Auto run · 14:15')
    expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(calls(fetchMock, 'GET /api/run/live')).toHaveLength(1)
    expect(within(toasts()).queryByText('Run finished')).not.toBeInTheDocument() // dismissed, and not raised again
  })

  it('sees a run start while the page is open, within one poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stub()
    render(<App />)
    await waitFor(() => expect(autoSwitch()).toBeEnabled())
    autoRunGoing()
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(await screen.findByText(/auto run going/i)).toBeInTheDocument()
  })

  it('looks as soon as the tab comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = stub()
    render(<App />)
    await waitFor(() => expect(autoSwitch()).toBeEnabled())
    setVisibility('hidden')
    const before = calls(fetchMock, 'GET /api/status').length
    autoRunGoing()
    setVisibility('visible')
    await waitFor(() => expect(calls(fetchMock, 'GET /api/status').length).toBe(before + 1))
    expect(await screen.findByText(/auto run going/i)).toBeInTheDocument()
  })

  it('shows a run that started and finished between two looks, with its notification', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stub()
    render(<App />)
    await waitFor(() => expect(autoSwitch()).toBeEnabled())
    server.state.latest = { started_by: 'auto', started_at: localTime(14, 30), finished_at: localTime(14, 31), report }
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(await screen.findByText('Auto run · 14:30')).toBeInTheDocument()
    expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
  })

  it('shows a run that ended just before the page could watch it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stub()
    render(<App />)
    await waitFor(() => expect(autoSwitch()).toBeEnabled())
    server.state.running = { started_by: 'auto', started_at: localTime(14, 45) }
    server.state.live = () => {
      server.state.running = null // over by the time the page asks to watch it
      server.state.latest = { started_by: 'auto', started_at: localTime(14, 45), finished_at: localTime(14, 46), report }
      return new Response(null, { status: 204 })
    }
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(await screen.findByText('Auto run · 14:45')).toBeInTheDocument()
    expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
    await waitFor(() => expect(runButton()).toBeEnabled())
  })

  it('does not watch its own run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const own = controlledRun()
    const fetchMock = stub({
      'POST /api/run': () => {
        server.state.running = { started_by: 'manual', started_at: new Date().toISOString() }
        return own.response()
      },
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /^run$/i }))
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    server.state.running = null
    server.state.latest = { started_by: 'manual', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), report }
    own.event({ type: 'report', report })
    own.close()
    await screen.findByRole('region', { name: /best slips/i })
    expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(calls(fetchMock, 'GET /api/run/live')).toHaveLength(0)
    expect(calls(fetchMock, 'GET /api/report/latest')).toHaveLength(1) // only on opening: its own report isn't fetched again
    expect(within(toasts()).queryByText('Run finished')).not.toBeInTheDocument() // dismissed, and not raised again
  })

  it('a refused Run says why and watches the run that is going', async () => {
    let refused = false
    const run = controlledRun()
    const fetchMock = stub({
      'POST /api/run': () => {
        refused = true
        server.state.running = { started_by: 'auto', started_at: localTime(14, 15) }
        server.state.live = run.response
        return Response.json({ detail: 'a run is already going (auto run, started 22:15)' }, { status: 409 })
      },
    })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    expect(refused).toBe(true)
    expect(await screen.findByText(/auto run going \(started 14:15\)/i)).toBeInTheDocument()
    expect(runButton()).toBeDisabled()
    expect(calls(fetchMock, 'GET /api/run/live')).toHaveLength(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument() // refused is not failed
    ends(run, { type: 'report', report })
    expect(await screen.findByText('Auto run · 14:15')).toBeInTheDocument()
  })

  it('stops watching when the page goes away, which leaves the run going', async () => {
    autoRunGoing()
    const fetchMock = stub()
    const { unmount } = render(<App />)
    await screen.findByText(/auto run going/i)
    const signal = calls(fetchMock, 'GET /api/run/live')[0][1]!.signal!
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
  })
})
