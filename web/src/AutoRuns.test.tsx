import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { controlledRun, fakeServer, head, localTime, options, report, routes, runInfo, streamed } from './test/fixtures'
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
    server.state.latest = { ...runInfo('auto', localTime(14, 15)), finished_at: localTime(14, 16), report }
    stub()
    render(<App />)
    expect(await screen.findByRole('region', { name: /best slips/i })).toBeInTheDocument()
    expect(screen.getByText('Auto run · 14:15')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /no report yet/i })).not.toBeInTheDocument()
    expect(within(toasts()).queryByText(/run finished/i)).not.toBeInTheDocument() // old news: no notification
  })

  it('shows a latest run that failed, marked as a manual run', async () => {
    server.state.latest = { ...runInfo('manual', localTime(14, 8)), finished_at: localTime(14, 9), error: 'no sportsbook odds available' }
    stub()
    render(<App />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No sportsbook odds available')
    expect(screen.getByText('Run · 14:08 failed')).toBeInTheDocument()
  })

  it("a new run's report replaces it, marked with when the server started it, not this browser's clock", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(new Date().setHours(16, 42, 0, 0)) })
    server.state.latest = { ...runInfo('auto', localTime(14, 15)), finished_at: localTime(14, 16), report }
    const own = runInfo('manual', localTime(16, 40)) // the server's clock is behind this browser's
    stub({ 'POST /api/run': () => streamed(own, { ...report, settings: { ...report.settings, stake: 33 } }) })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await screen.findByText('Auto run · 14:15')
    await user.click(runButton())
    expect(await screen.findByText(/\$33 stake · multiplicative devig/)).toBeInTheDocument()
    expect(screen.getByText('Run · 16:40')).toBeInTheDocument()
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
    const info = runInfo('auto', at)
    server.state.running = info
    server.state.live = () => {
      const res = run.response()
      run.event(head(info))
      return res
    }
    return { ...run, info }
  }

  function ends(run: ReturnType<typeof autoRunGoing>, event: object) {
    server.state.running = null
    server.state.latest = { ...run.info, finished_at: run.info.started_at, ...('report' in event ? { report } : { error: 'x' }) }
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
    expect(screen.getByText('Auto run · 14:15 failed')).toBeInTheDocument()
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
    server.state.latest = { ...runInfo('auto', localTime(14, 30)), finished_at: localTime(14, 31), report }
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(await screen.findByText('Auto run · 14:30')).toBeInTheDocument()
    expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
  })

  it('shows a run that ended just before the page could watch it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stub()
    render(<App />)
    await waitFor(() => expect(autoSwitch()).toBeEnabled())
    const late = runInfo('auto', localTime(14, 45))
    server.state.running = late
    server.state.live = () => {
      server.state.running = null // over by the time the page asks to watch it
      server.state.latest = { ...late, finished_at: localTime(14, 46), report }
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
    const ownRun = runInfo('manual', new Date().toISOString())
    const fetchMock = stub({
      'POST /api/run': () => {
        server.state.running = ownRun
        own.event(head(ownRun))
        return own.response()
      },
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /^run$/i }))
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    server.state.running = null
    server.state.latest = { ...ownRun, finished_at: new Date().toISOString(), report }
    own.event({ type: 'report', report })
    own.close()
    await screen.findByRole('region', { name: /best slips/i })
    expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(calls(fetchMock, 'GET /api/run/live')).toHaveLength(0)
    expect(calls(fetchMock, 'GET /api/report/latest')).toHaveLength(0) // its own report: never fetched back
    expect(within(toasts()).queryByText('Run finished')).not.toBeInTheDocument() // dismissed, and not raised again
  })

  it('a refused Run says why and watches the run that is going', async () => {
    let refused = false
    let run!: ReturnType<typeof autoRunGoing>
    const fetchMock = stub({
      'POST /api/run': () => {
        refused = true
        run = autoRunGoing()
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

describe('Runs known by id (Sprint 9 review)', () => {
  /** A run going on the server that the page can watch; each look at /api/run/live is a stream of its own. */
  function going(by: 'auto' | 'manual', at: string) {
    const info = runInfo(by, at)
    const streams: ReturnType<typeof controlledRun>[] = []
    server.state.running = info
    server.state.live = () => {
      const s = controlledRun()
      streams.push(s)
      s.event(head(info))
      return s.response()
    }
    return { info, streams, last: () => streams.at(-1)! }
  }

  const poll = () => act(() => vi.advanceTimersByTimeAsync(5000))

  it("a Run the server never started (422) doesn't take the next recorded run for its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stub({
      'POST /api/run': () => {
        // An auto run is recorded just as this page's request is turned away.
        server.state.latest = { ...runInfo('auto', localTime(14, 30)), finished_at: localTime(14, 31), report }
        return Response.json({ detail: 'stake: must be more than 0' }, { status: 422 })
      },
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /^run$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Stake: must be more than 0')
    expect(await screen.findByText('Auto run · 14:30')).toBeInTheDocument()
    expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
  })

  it("nor does one whose request never reached the server", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stub({
      'POST /api/run': () => {
        // Another page's run is recorded while this page's request goes nowhere.
        server.state.latest = { ...runInfo('manual', localTime(14, 33)), finished_at: localTime(14, 34), report }
        return Promise.reject(new TypeError('Failed to fetch'))
      },
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /^run$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch')
    expect(await screen.findByText('Run · 14:33')).toBeInTheDocument()
    expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
  })

  it('opens on a latest run recorded before runs had ids, as old news, and shows the next one as new', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    server.state.latest = { id: null, started_by: 'auto', started_at: localTime(14, 15), finished_at: localTime(14, 16), report }
    const fetchMock = stub()
    render(<App />)
    await screen.findByText('Auto run · 14:15')
    await poll()
    await poll()
    expect(within(toasts()).queryByText('Run finished')).not.toBeInTheDocument()
    expect(calls(fetchMock, 'GET /api/report/latest')).toHaveLength(1)

    server.state.latest = { ...runInfo('auto', localTime(14, 30)), finished_at: localTime(14, 31), error: 'books down' }
    await poll()
    expect(await screen.findByText('Auto run · 14:30 failed')).toBeInTheDocument()
    expect(within(toasts()).getByText('Run failed')).toBeInTheDocument()
  })

  describe('a watched run whose stream drops', () => {
    it('is not a failed run: Run stays held, and the next look watches it again to its end', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const run = going('auto', localTime(14, 15))
      const fetchMock = stub()
      render(<App />)
      await screen.findByText(/auto run going/i)
      run.last().fail() // the laptop slept
      await act(() => vi.advanceTimersByTimeAsync(10))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(within(toasts()).queryByText('Run failed')).not.toBeInTheDocument()
      expect(runButton()).toBeDisabled()
      expect(screen.getByText(/auto run going/i)).toBeInTheDocument()

      await poll()
      await waitFor(() => expect(calls(fetchMock, 'GET /api/run/live')).toHaveLength(2))
      run.last().event({ type: 'progress', done: 6, total: 10, step: 'FanDuel NBA' })
      await screen.findByText('60%')
      server.state.running = null
      server.state.latest = { ...run.info, finished_at: localTime(14, 16), report }
      run.last().event({ type: 'report', report })
      run.last().close()
      expect(await screen.findByText('Auto run · 14:15')).toBeInTheDocument()
      expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
      await waitFor(() => expect(runButton()).toBeEnabled())
    })

    it('that ended meanwhile is shown from the latest run, with its notification', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const run = going('auto', localTime(14, 15))
      stub()
      render(<App />)
      await screen.findByText(/auto run going/i)
      run.last().close() // cut off before its end arrived
      server.state.running = null
      server.state.latest = { ...run.info, finished_at: localTime(14, 16), report }
      await poll()
      expect(await screen.findByText('Auto run · 14:15')).toBeInTheDocument()
      expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      await waitFor(() => expect(runButton()).toBeEnabled())
    })
  })

  describe("this page's own run whose stream drops", () => {
    /** Press Run: the server starts the run and streams its head, then the connection drops. */
    async function dropped() {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const own = controlledRun()
      const info = runInfo('manual', localTime(9, 5))
      const fetchMock = stub({
        'POST /api/run': () => {
          server.state.running = info
          own.event(head(info))
          own.event({ type: 'progress', done: 2, total: 10, step: 'DraftKings NFL' })
          return own.response()
        },
      })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<App />)
      await user.click(await screen.findByRole('button', { name: /^run$/i }))
      await screen.findByText('20%')
      own.fail()
      await act(() => vi.advanceTimersByTimeAsync(10))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(within(toasts()).queryByText('Run failed')).not.toBeInTheDocument()
      expect(runButton()).toBeDisabled()
      return { info, fetchMock }
    }

    it('still going, is watched again as its own, to its report', async () => {
      const { info, fetchMock } = await dropped()
      const again = controlledRun()
      server.state.live = () => {
        again.event(head(info))
        return again.response()
      }
      await poll()
      await waitFor(() => expect(calls(fetchMock, 'GET /api/run/live')).toHaveLength(1))
      expect(runButton()).toHaveTextContent('Running…')
      server.state.running = null
      server.state.latest = { ...info, finished_at: localTime(9, 6), report }
      again.event({ type: 'report', report })
      again.close()
      expect(await screen.findByText('Run · 09:05')).toBeInTheDocument()
      expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
      await waitFor(() => expect(runButton()).toBeEnabled())
    })

    it('that finished meanwhile is shown from the latest run, with its notification', async () => {
      const { info } = await dropped()
      server.state.running = null
      server.state.latest = { ...info, finished_at: localTime(9, 6), report }
      await poll()
      expect(await screen.findByText('Run · 09:05')).toBeInTheDocument()
      expect(within(toasts()).getByText('Run finished')).toBeInTheDocument()
    })

    it('that the server stopped (its starter went away) says so, without a run notification', async () => {
      await dropped()
      server.state.running = null // cancelled, and so never recorded
      await poll()
      expect(await screen.findByRole('alert')).toHaveTextContent(/the run was stopped/i)
      expect(screen.getByText('Run · 09:05 failed')).toBeInTheDocument()
      expect(within(toasts()).queryByText('Run failed')).not.toBeInTheDocument()
      await waitFor(() => expect(runButton()).toBeEnabled())
    })

    it('watched again and then stopped by the server says so, without a run notification', async () => {
      const { info } = await dropped()
      const again = controlledRun()
      server.state.live = () => {
        again.event(head(info))
        return again.response()
      }
      await poll()
      await waitFor(() => expect(runButton()).toHaveTextContent('Running…'))
      server.state.running = null
      again.event({ type: 'error', detail: 'the run was stopped: the page that started it was closed' })
      again.close()
      expect(await screen.findByRole('alert')).toHaveTextContent(/the run was stopped/i)
      expect(within(toasts()).queryByText('Run failed')).not.toBeInTheDocument()
    })
  })

  it("a refusal doesn't hold Run once the run that refused it has gone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = stub({
      // Refused, but the auto run that got there first ends before this page looks.
      'POST /api/run': () => Response.json({ detail: 'a run is already going (auto run)' }, { status: 409 }),
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /^run$/i }))
    await waitFor(() => expect(calls(fetchMock, 'POST /api/run')).toHaveLength(1))
    await poll()
    await waitFor(() => expect(runButton()).toBeEnabled())
    expect(screen.queryByText(/a run is already going/i)).not.toBeInTheDocument()
  })
})
