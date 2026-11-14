import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { controlledRun, fakeServer, head, localTime, options, report, routes, runInfo } from './test/fixtures'

// Sprint 11, M1–M2 and MO-6: one column that puts Run and the report first and the setup after them; on a phone Run
// sits in a bar at the foot of the screen with the auto runs switch (the time of the next run stays in the page); the
// theme is chosen at the foot of the page; and a run started here brings its progress into view.

const board = () => Response.json({ saved_at: new Date().toISOString(), projections: 11, source: 'fetched' })
let server: ReturnType<typeof fakeServer>

function stub(table: Parameters<typeof routes>[0] = {}) {
  const fn = vi.fn(
    routes({
      ...server.routes,
      'GET /api/options': () => Response.json(options),
      'GET /api/board': board,
      'POST /api/run': () => Response.json(report),
      ...table,
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

const scrolled = vi.fn()
let reduced = false

beforeEach(() => {
  server = fakeServer()
  server.state.settings = { ...options.defaults, saved: true, updated_at: null }
  scrolled.mockClear()
  reduced = false
  Element.prototype.scrollIntoView = scrolled
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') && reduced,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const runButton = () => screen.getByRole('button', { name: /^run/i })
const ready = async () => {
  await screen.findByRole('button', { name: 'NBA', pressed: true })
  await waitFor(() => expect(runButton()).toBeEnabled())
}
/** True when `a` comes before `b` in the page. */
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('One column', () => {
  it('reads board, Run, the report, then the setup cards: run settings, promotion, phone alerts', async () => {
    stub()
    render(<App />)
    await ready()
    await userEvent.click(runButton())
    const slips = await screen.findByRole('region', { name: /best slips/i })
    const order = [
      screen.getByRole('region', { name: 'Board' }),
      runButton(),
      slips,
      screen.getByRole('region', { name: 'Run settings' }),
      screen.getByRole('region', { name: 'Promotion' }),
      screen.getByRole('region', { name: 'Phone alerts' }),
    ]
    for (let i = 1; i < order.length; i++) expect(before(order[i - 1], order[i])).toBe(true)
  })

  it('offers Fresh odds beside Run, not inside the run settings', async () => {
    stub()
    render(<App />)
    await ready()
    const fresh = screen.getByLabelText(/fresh odds/i)
    expect(within(screen.getByRole('region', { name: 'Run settings' })).queryByLabelText(/fresh odds/i)).toBeNull()
    expect(fresh.closest('.run-row')).toBe(runButton().closest('.run-row'))
  })

  it('chooses the theme at the foot of the page, after everything else', async () => {
    stub()
    render(<App />)
    await ready()
    const theme = screen.getByRole('group', { name: 'Theme' })
    expect(theme.closest('header')).toBeNull()
    expect(theme.closest('footer')).not.toBeNull()
    expect(before(screen.getByRole('region', { name: 'Phone alerts' }), theme)).toBe(true)
  })
})

describe('The Run bar', () => {
  it('holds Run and the auto runs switch; the next run and Fresh odds stay in the page', async () => {
    server.state.auto = { enabled: true, next_run_at: localTime(14, 30), off_reason: null }
    stub()
    render(<App />)
    const next = await screen.findByText('Next run 14:30')
    const bar = runButton().closest('.run-bar')!
    expect(bar).not.toBeNull()
    expect(within(bar as HTMLElement).getByRole('switch', { name: /auto runs/i })).toBeInTheDocument()
    expect(bar.contains(next)).toBe(false)
    expect(bar.contains(screen.getByLabelText(/fresh odds/i))).toBe(false)
  })
})

describe('A run started here', () => {
  it('brings its progress into view, smoothly, without moving more than it must', async () => {
    const run = controlledRun()
    stub({ 'POST /api/run': run.response })
    render(<App />)
    await ready()
    await userEvent.click(runButton())
    const bar = await screen.findByRole('progressbar', { name: /run progress/i })
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1))
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' })
    expect(scrolled.mock.contexts[0]).toBe(bar.closest('.run-progress'))
    run.event(head(runInfo('manual', localTime(9, 5))))
    run.event({ type: 'progress', done: 3, total: 10, step: 'DraftKings NBA' })
    await screen.findByText('30%')
    expect(scrolled).toHaveBeenCalledTimes(1) // once, as it starts, not on every step
    run.event({ type: 'report', report })
    run.close()
  })

  it('jumps rather than glides when motion is reduced', async () => {
    reduced = true
    const run = controlledRun()
    stub({ 'POST /api/run': run.response })
    render(<App />)
    await ready()
    await userEvent.click(runButton())
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' }))
    run.close()
  })

  it('but a run this page only watches never moves the page', async () => {
    const run = controlledRun()
    const info = runInfo('auto', localTime(14, 15))
    server.state.running = info
    server.state.live = () => {
      const res = run.response()
      run.event(head(info))
      return res
    }
    stub()
    render(<App />)
    expect(await screen.findByRole('progressbar', { name: /run progress/i })).toBeInTheDocument()
    expect(scrolled).not.toHaveBeenCalled()
    run.close()
  })
})
