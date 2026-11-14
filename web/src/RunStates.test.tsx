import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { controlledRun, fakeServer, head, localTime, options, report, routes, runInfo, streamed } from './test/fixtures'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const board = () => Response.json({ saved_at: minutesAgo(1), projections: 11, source: 'fetched' })

let server: ReturnType<typeof fakeServer>
beforeEach(() => {
  server = fakeServer()
  server.state.settings = { ...options.defaults, saved: true }
})
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

function stub(table: Parameters<typeof routes>[0] = {}) {
  const fn = vi.fn(
    routes({
      ...server.routes,
      'GET /api/health': () => Response.json({ status: 'ok' }),
      'GET /api/options': () => Response.json(options),
      'GET /api/board': board,
      ...table,
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

/** A route that answers only once `open` is called. */
function gated(route: () => Response | Promise<Response>) {
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  return { route: async () => (await gate, route()), open: () => open() }
}

const calls = (f: ReturnType<typeof stub>, url: string) => f.mock.calls.filter(([u]) => u === url).length
const runButton = () => screen.getByRole('button', { name: /^run/i })
const reportRoot = () => document.querySelector('.report')!

describe('Empty report', () => {
  it('waits for the server to say there is no run yet before saying so', async () => {
    const status = gated(() => server.routes['GET /api/status']())
    const fetchMock = stub({ 'GET /api/status': status.route })
    render(<App />)
    await waitFor(() => expect(calls(fetchMock, '/api/status')).toBeGreaterThan(0))
    await screen.findByRole('button', { name: /^run$/i })
    expect(screen.queryByRole('region', { name: /no report yet/i })).not.toBeInTheDocument()
    status.open()
    expect(await screen.findByRole('region', { name: /no report yet/i })).toBeInTheDocument()
  })

  it('never shows while the latest report is on its way', async () => {
    server.state.latest = { ...runInfo('auto', localTime(14, 15)), finished_at: localTime(14, 16), report }
    const latest = gated(() => server.routes['GET /api/report/latest']())
    const fetchMock = stub({ 'GET /api/report/latest': latest.route })
    render(<App />)
    await waitFor(() => expect(calls(fetchMock, '/api/report/latest')).toBe(1))
    expect(screen.queryByRole('region', { name: /no report yet/i })).not.toBeInTheDocument()
    latest.open()
    expect(await screen.findByRole('region', { name: /best slips/i })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /no report yet/i })).not.toBeInTheDocument()
  })

  it('keeps the Best Slips and Top Legs headings, each over one sentence', async () => {
    stub()
    render(<App />)
    const empty = await screen.findByRole('region', { name: /no report yet/i })
    expect(within(empty).getByRole('heading', { name: 'Best Slips' })).toBeInTheDocument()
    expect(within(empty).getByRole('heading', { name: 'Top Legs' })).toBeInTheDocument()
    expect(empty.querySelectorAll('.empty-box')).toHaveLength(2)
    expect(screen.queryByRole('region', { name: /best slips/i })).not.toBeInTheDocument()
  })
})

describe('Run failure', () => {
  const failing = (run = runInfo('manual', localTime(9, 55))) => () =>
    new Response(
      [head(run), { type: 'error', detail: 'no sportsbook odds available: draftkings unavailable' }]
        .map((e) => JSON.stringify(e) + '\n')
        .join(''),
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    )

  it('marks the failed run on its own line, then the reason as a sentence', async () => {
    stub({ 'POST /api/run': failing() })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Run · 09:55 failed')).toBeInTheDocument()
    expect(within(alert).getByText('No sportsbook odds available: draftkings unavailable')).toBeInTheDocument()
  })

  it('offers to try again with the same settings', async () => {
    const fetchMock = stub({ 'POST /api/run': failing() })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    const alert = await screen.findByRole('alert')
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(calls(fetchMock, '/api/run')).toBe(2))
    const bodies = fetchMock.mock.calls.filter(([u]) => u === '/api/run').map(([, init]) => JSON.parse(String(init!.body)))
    expect(bodies[1]).toEqual(bodies[0])
  })

  it('writes a request error as a sentence too', async () => {
    stub({ 'POST /api/run': () => Response.json({ detail: 'stake must be positive' }, { status: 422 }) })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Stake must be positive/)
  })
})

describe('Stale report', () => {
  beforeEach(() => {
    server.state.latest = { ...runInfo('auto', localTime(14, 15)), finished_at: localTime(14, 16), report }
  })

  it('opens without a fade, dims while a run is going, and a new result replaces it with a fade', async () => {
    const run = controlledRun()
    stub({ 'POST /api/run': run.response })
    render(<App />)
    await screen.findByText('Auto run · 14:15')
    const opened = reportRoot()
    expect(opened).toHaveAttribute('data-opened')
    expect(opened).not.toHaveAttribute('data-stale')

    await userEvent.click(runButton())
    await waitFor(() => expect(reportRoot()).toHaveAttribute('aria-busy', 'true'))
    expect(reportRoot()).toHaveAttribute('data-stale')
    expect(screen.getByText('Previous auto run · 14:15')).toBeInTheDocument()

    run.event(head(runInfo('manual', localTime(16, 40))))
    run.event({ type: 'report', report })
    run.close()
    expect(await screen.findByText('Run · 16:40')).toBeInTheDocument()
    const fresh = reportRoot()
    expect(fresh).not.toBe(opened) // a new result mounts afresh, so it plays the fade
    expect(fresh).not.toHaveAttribute('data-opened')
    expect(fresh).not.toHaveAttribute('data-stale')
    expect(fresh).not.toHaveAttribute('aria-busy')
  })

  it('stays dimmed, not busy, under a newer failure', async () => {
    stub({
      'POST /api/run': () =>
        new Response([head(runInfo('manual', localTime(16, 40))), { type: 'error', detail: 'books down' }].map((e) => JSON.stringify(e) + '\n').join(''), {
          headers: { 'Content-Type': 'application/x-ndjson' },
        }),
    })
    render(<App />)
    await screen.findByText('Auto run · 14:15')
    await userEvent.click(runButton())
    await screen.findByText('Run · 16:40 failed')
    expect(reportRoot()).toHaveAttribute('data-stale')
    expect(reportRoot()).not.toHaveAttribute('aria-busy')
    expect(screen.getByText('Previous auto run · 14:15')).toBeInTheDocument()
  })

  it('a fresh report clears the failure and the dimming', async () => {
    let fail = true
    stub({
      'POST /api/run': () =>
        fail
          ? new Response([head(runInfo('manual', localTime(16, 40))), { type: 'error', detail: 'books down' }].map((e) => JSON.stringify(e) + '\n').join(''), {
              headers: { 'Content-Type': 'application/x-ndjson' },
            })
          : streamed(runInfo('manual', localTime(16, 45))),
    })
    render(<App />)
    await screen.findByText('Auto run · 14:15')
    await userEvent.click(runButton())
    await screen.findByText('Run · 16:40 failed')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Run · 16:45')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(reportRoot()).not.toHaveAttribute('data-stale')
  })
})
