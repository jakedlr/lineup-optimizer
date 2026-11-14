import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { clock } from './format'
import { controlledRun, fakeServer, head, localTime, options, report, routes, runInfo } from './test/fixtures'
import { POLL_MS } from './useServerStatus'

// Sprint 11, group C: the controls, panels and chrome say what they're doing, and why they're held, where it happens.

const board = () => Response.json({ saved_at: new Date().toISOString(), projections: 11, source: 'fetched' })
const LINES = 'GET /api/board/lines?sports=NFL%2CNBA%2CNHL%2CMLB&hours=24'
const boardLines = [{ sport: 'NFL', matchup: 'CHI vs NE', player: 'Drake Maye', stat_label: 'Pass Yards', line: 249.5 }]
let server: ReturnType<typeof fakeServer>

function stub(table: Parameters<typeof routes>[0] = {}) {
  const fn = vi.fn(
    routes({
      ...server.routes,
      'GET /api/options': () => Response.json(options),
      'GET /api/board': board,
      [LINES]: () => Response.json(boardLines),
      'POST /api/run': () => Response.json(report),
      ...table,
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

const calls = (f: ReturnType<typeof stub>, key: string) =>
  f.mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key)

beforeEach(() => {
  server = fakeServer()
  server.state.settings = { ...options.defaults, saved: true, updated_at: null }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const settingsCard = () => screen.getByRole('region', { name: 'Run settings' })
const promoCard = () => screen.getByRole('region', { name: 'Promotion' })
const runButton = () => screen.getByRole('button', { name: /^run/i })
const ready = async () => {
  await screen.findByRole('button', { name: 'NBA', pressed: true })
  await waitFor(() => expect(runButton()).toBeEnabled())
}

describe('Engine status', () => {
  it('is told by the status polls, never by a separate health check', async () => {
    const fetchMock = stub()
    render(<App />)
    expect(await screen.findByText('Engine online')).toBeInTheDocument()
    expect(calls(fetchMock, 'GET /api/health')).toHaveLength(0)
  })

  it('says offline, retrying, after two polls go unanswered, and online again once one is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let down = true
    const status = server.routes['GET /api/status']
    stub({ 'GET /api/status': (init) => (down ? Promise.reject(new TypeError('network down')) : status(init)) })
    render(<App />)
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(screen.queryByText(/engine offline/i)).not.toBeInTheDocument() // one miss is a blip
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    expect(await screen.findByText('Engine offline: retrying')).toBeInTheDocument()
    down = false
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    expect(await screen.findByText('Engine online')).toBeInTheDocument()
  })
})

describe('Run button', () => {
  it("is busy, not greyed out, while this page's run goes, and reads how far along it is", async () => {
    const run = controlledRun()
    stub({ 'POST /api/run': run.response })
    render(<App />)
    await ready()
    await userEvent.click(runButton())
    const button = runButton()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveTextContent(/^Running…$/)
    run.event(head(runInfo('manual', localTime(9, 5))))
    run.event({ type: 'progress', done: 39, total: 100, step: 'DraftKings NFL' })
    await waitFor(() => expect(button).toHaveTextContent(/^Running… 39%$/))
    run.event({ type: 'report', report })
    run.close()
    await waitFor(() => expect(button).toHaveTextContent(/^Run$/))
    expect(button).not.toHaveAttribute('aria-busy')
  })

  it('unticks Fresh odds once the server has named the run it asked for', async () => {
    const run = controlledRun()
    const fetchMock = stub({ 'POST /api/run': run.response })
    render(<App />)
    await ready()
    await userEvent.click(screen.getByText('Advanced'))
    const fresh = screen.getByLabelText(/fresh odds/i)
    await userEvent.click(fresh)
    await userEvent.click(runButton())
    expect(JSON.parse(String(calls(fetchMock, 'POST /api/run')[0][1]!.body)).no_cache).toBe(true)
    expect(fresh).toBeChecked()
    run.event(head(runInfo('manual', localTime(9, 5))))
    await waitFor(() => expect(fresh).not.toBeChecked())
    run.close()
  })
})

describe('Auto runs switch', () => {
  it('stays legible until the server has said whether auto runs are on, then works', async () => {
    let answer!: () => void
    const status = server.routes['GET /api/status']
    stub({ 'GET /api/status': (init) => new Promise<Response>((r) => (answer = () => r(status(init) as Response))) })
    render(<App />)
    const toggle = screen.getByRole('switch', { name: /auto runs/i })
    expect(toggle).not.toBeDisabled() // full opacity: it's waiting, not off-limits
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await waitFor(() => expect(answer).toBeTypeOf('function'))
    act(() => answer())
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'))
  })
})

describe('Run settings card', () => {
  it('shows the cards and their titles at once, with placeholders, while the settings load', () => {
    stub({ 'GET /api/options': () => new Promise<Response>(() => {}) })
    render(<App />)
    expect(settingsCard()).toHaveAttribute('aria-busy', 'true')
    expect(promoCard()).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('region', { name: 'Phone alerts' })).toBeInTheDocument()
  })

  it('drops the placeholders when the settings could not load', async () => {
    stub({ 'GET /api/options': () => Response.json({ detail: 'boom' }, { status: 500 }) })
    render(<App />)
    expect(await screen.findByText(/couldn't load run settings/i)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Run settings' })).not.toBeInTheDocument()
  })

  it('says when the run settings were saved, and that auto runs use them too', async () => {
    const at = '2026-11-13T17:55:00Z' // before the fake server's own saves
    server.state.settings = { ...options.defaults, saved: true, updated_at: at }
    stub()
    render(<App />)
    const stamp = await screen.findByText(`Saved ${clock(at)} · auto runs use these too`)
    expect(settingsCard()).toContainElement(stamp)
    await userEvent.click(screen.getByRole('button', { name: 'MLB' }))
    await waitFor(() => expect(server.state.settings.updated_at).not.toBe(at))
    expect(
      await within(settingsCard()).findByText(`Saved ${clock(server.state.settings.updated_at as string)} · auto runs use these too`),
    ).toBeInTheDocument()
  })

  it('says only that auto runs use them while they have never been saved', async () => {
    server.state.settings = { ...options.defaults, saved: false, updated_at: null }
    stub()
    render(<App />)
    await ready()
    expect(within(settingsCard()).getByText('Auto runs use these too')).toBeInTheDocument()
  })

  it('marks each league chip that is on with a check, for more than its fill', async () => {
    stub()
    render(<App />)
    await ready()
    const nba = within(settingsCard()).getByRole('button', { name: 'NBA' })
    expect(nba.querySelector('svg.check')).not.toBeNull()
    await userEvent.click(nba)
    expect(nba.querySelector('svg.check')).toBeNull()
  })
})

describe('Why Run is held, said where the cause is', () => {
  it('with no league, under the chips as well as beside Run', async () => {
    stub()
    render(<App />)
    await ready()
    for (const s of options.sports) await userEvent.click(within(settingsCard()).getByRole('button', { name: s }))
    expect(runButton()).toBeDisabled()
    expect(within(settingsCard()).getByRole('group', { name: 'Leagues' })).toHaveAccessibleDescription('Pick at least one league.')
    expect(screen.getAllByText('Pick at least one league.')).toHaveLength(2)
  })

  it('with a stake of $0, marks the stake and says why under it', async () => {
    stub()
    render(<App />)
    await ready()
    const stake = within(settingsCard()).getByLabelText(/^stake/i)
    expect(stake).toHaveAttribute('aria-invalid', 'false')
    await userEvent.clear(stake)
    await userEvent.type(stake, '0')
    expect(stake).toHaveAttribute('aria-invalid', 'true')
    expect(stake).toHaveAccessibleDescription('Stake must be more than $0.')
  })

  it('with no hours ahead, marks the field and says why under it', async () => {
    stub()
    render(<App />)
    await ready()
    await userEvent.click(screen.getByText('Advanced'))
    const hours = within(settingsCard()).getByLabelText(/hours ahead/i)
    await userEvent.clear(hours)
    expect(hours).toHaveAttribute('aria-invalid', 'true')
    expect(hours).toHaveAccessibleDescription('Hours ahead must be more than 0.')
  })

  it('with a promotion that cannot run, in the Promotion card', async () => {
    stub()
    render(<App />)
    await ready()
    await userEvent.click(within(promoCard()).getByRole('button', { name: 'Promo legs' }))
    expect(within(promoCard()).getByText('Add a promo leg, or set Promotion to None.')).toBeInTheDocument()
    expect(screen.getAllByText('Add a promo leg, or set Promotion to None.')).toHaveLength(2)
  })
})

describe('Board card', () => {
  it('offers the upload quietly while the board is fresh and the fetch worked', async () => {
    stub()
    render(<App />)
    const quiet = await screen.findByText('Upload a board instead')
    expect(quiet.closest('details')).not.toHaveAttribute('open')
    expect(screen.queryByText(/board fetch failing/i)).not.toBeInTheDocument()
  })

  it('asks plainly, opened, when there is no board and the fetch failed', async () => {
    stub({
      'GET /api/board': () => Response.json({ detail: 'no board yet' }, { status: 404 }),
      'POST /api/board/fetch': () => Response.json({ detail: 'HTTP 503 from partner-api' }, { status: 502 }),
    })
    render(<App />)
    const loud = await screen.findByText('Board fetch failing? Upload one instead')
    expect(loud.closest('details')).toHaveAttribute('open')
  })
})

describe('Promo leg picker', () => {
  async function pickMaye() {
    stub()
    render(<App />)
    await ready()
    await userEvent.click(within(promoCard()).getByRole('button', { name: 'Promo legs' }))
    await userEvent.type(await screen.findByLabelText(/find a line/i), 'maye')
  }

  it('lists the lines found as plain buttons in a list', async () => {
    await pickMaye()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    const results = screen.getByRole('list', { name: 'Board lines' })
    expect(within(results).getAllByRole('button')).toHaveLength(1)
    await userEvent.click(within(results).getByRole('button', { name: /drake maye/i }))
    expect(screen.getByLabelText('Promo line')).toHaveValue(249.5)
  })

  it('checks the promo line when it is left or on Add, not while it is typed', async () => {
    await pickMaye()
    await userEvent.click(screen.getByRole('button', { name: /drake maye/i }))
    const line = screen.getByLabelText('Promo line')
    await userEvent.clear(line)
    await userEvent.type(line, '260')
    expect(screen.queryByText(/half-point/i)).not.toBeInTheDocument()
    expect(line).toHaveAttribute('aria-invalid', 'false')
    await userEvent.tab()
    expect(screen.getByText(/half-point/i)).toBeInTheDocument()
    expect(line).toHaveAttribute('aria-invalid', 'true')

    await userEvent.clear(line)
    await userEvent.type(line, '260.5')
    expect(screen.queryByText(/half-point/i)).not.toBeInTheDocument()
  })

  it('Add with a line that is not a half point says so and adds nothing', async () => {
    await pickMaye()
    await userEvent.click(screen.getByRole('button', { name: /drake maye/i }))
    const line = screen.getByLabelText('Promo line')
    await userEvent.clear(line)
    await userEvent.type(line, '260')
    await userEvent.click(screen.getByRole('button', { name: /add promo leg/i }))
    expect(screen.getByText(/half-point/i)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: /promo legs/i })).not.toBeInTheDocument()
  })
})

describe('Run notification pop-up', () => {
  const region = () => screen.getByRole('status', { name: /run notifications/i })

  async function popped() {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stub()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await ready()
    await user.click(runButton())
    await within(region()).findByText('Run finished')
    return { user, toast: region().querySelector<HTMLElement>('.toast')! }
  }

  it('holds while the pointer is on it, then takes the rest of its time', async () => {
    const { toast } = await popped()
    act(() => vi.advanceTimersByTime(4000))
    fireEvent.pointerEnter(toast)
    act(() => vi.advanceTimersByTime(10_000))
    expect(region()).toHaveTextContent('Run finished')
    fireEvent.pointerLeave(toast)
    act(() => vi.advanceTimersByTime(1500))
    expect(region()).toHaveTextContent('Run finished') // 2s were left
    act(() => vi.advanceTimersByTime(1000))
    expect(region()).toBeEmptyDOMElement()
  })

  it('holds while focus is in it', async () => {
    const { toast } = await popped()
    act(() => within(toast).getByRole('button', { name: /dismiss/i }).focus())
    act(() => vi.advanceTimersByTime(10_000))
    expect(region()).toHaveTextContent('Run finished')
    act(() => within(toast).getByRole('button', { name: /dismiss/i }).blur())
    act(() => vi.advanceTimersByTime(6200))
    expect(region()).toBeEmptyDOMElement()
  })

  it('fades out when it goes, then leaves', async () => {
    const { user, toast } = await popped()
    await user.click(within(toast).getByRole('button', { name: /dismiss/i }))
    expect(toast).toHaveAttribute('data-leaving')
    act(() => vi.advanceTimersByTime(150))
    expect(region()).toBeEmptyDOMElement()
  })
})
