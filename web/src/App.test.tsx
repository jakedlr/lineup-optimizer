import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { options, report, routes } from './test/fixtures'

const health = () => Response.json({ status: 'ok' })
const noBoard = () => Response.json({ detail: 'no board uploaded yet' }, { status: 404 })
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

function stub(table: Parameters<typeof routes>[0]) {
  const fn = vi.fn(routes({ 'GET /api/health': health, 'GET /api/options': () => Response.json(options), ...table }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('App shell', () => {
  it('names the app', () => {
    stub({ 'GET /api/board': noBoard })
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: /prizepicks ev optimizer/i })).toBeInTheDocument()
  })

  it('reports the engine online when /api/health answers ok', async () => {
    stub({ 'GET /api/board': noBoard })
    render(<App />)
    expect(await screen.findByText(/engine online/i)).toBeInTheDocument()
  })

  it('reports the engine offline when /api/health fails', async () => {
    stub({ 'GET /api/health': () => Promise.reject(new TypeError('network down')), 'GET /api/board': noBoard })
    render(<App />)
    expect(await screen.findByText(/engine offline/i)).toBeInTheDocument()
  })
})

describe('Board', () => {
  it('asks for a board and keeps Run disabled until there is one', async () => {
    stub({ 'GET /api/board': noBoard })
    render(<App />)
    expect(await screen.findByText(/no board yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled()
  })

  it('shows the saved board and how old it is', async () => {
    const saved_at = minutesAgo(5)
    stub({ 'GET /api/board': () => Response.json({ saved_at, projections: 1234 }) })
    render(<App />)
    expect(await screen.findByText(/saved 5 min ago/i)).toBeInTheDocument()
    expect(screen.getByText(/1,234 lines/i)).toBeInTheDocument()
    expect(screen.queryByText(/lines may have moved/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^run$/i })).toBeEnabled()
  })

  it('flags a board older than 30 minutes as stale', async () => {
    const saved_at = minutesAgo(45)
    stub({ 'GET /api/board': () => Response.json({ saved_at, projections: 10 }) })
    render(<App />)
    expect(await screen.findByText(/saved 45 min ago/i)).toBeInTheDocument()
    expect(screen.getByText(/lines may have moved/i)).toBeInTheDocument()
  })

  it('uploads a chosen file and shows the new board', async () => {
    const fetchMock = stub({
      'GET /api/board': noBoard,
      'PUT /api/board': () => Response.json({ saved_at: minutesAgo(0), projections: 11 }),
    })
    render(<App />)
    await screen.findByText(/no board yet/i)

    const file = new File(['{"data":[]}'], 'projections.json', { type: 'application/json' })
    await userEvent.upload(screen.getByLabelText(/choose board file/i), file)

    expect(await screen.findByText(/saved just now/i)).toBeInTheDocument()
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!
    expect((put[1]!.body as FormData).get('file')).toBe(file)
  })

  it('shows why an upload was rejected', async () => {
    stub({
      'GET /api/board': noBoard,
      'PUT /api/board': () => Response.json({ detail: "that file isn't a PrizePicks projections feed" }, { status: 422 }),
    })
    render(<App />)
    await screen.findByText(/no board yet/i)
    await userEvent.upload(screen.getByLabelText(/choose board file/i), new File(['x'], 'x.json'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/isn't a PrizePicks projections feed/i)
  })
})

describe('Board instructions', () => {
  const FEED = 'https://api.prizepicks.com/projections?per_page=1000&single_stat=true&game_mode=pickem'

  it('links to the PrizePicks feed to save, opening in a new tab', async () => {
    stub({ 'GET /api/board': noBoard })
    render(<App />)
    await screen.findByText(/no board yet/i)
    const link = screen.getByRole('link', { name: /api\.prizepicks\.com\/projections/i })
    expect(link).toHaveAttribute('href', FEED)
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByRole('link', { name: /app\.prizepicks\.com/i })).toHaveAttribute('href', 'https://app.prizepicks.com')
  })

  it('shows the steps when there is no board or it is stale, and tucks them away otherwise', async () => {
    const fresh = minutesAgo(2)
    stub({ 'GET /api/board': () => Response.json({ saved_at: fresh, projections: 10 }) })
    const { unmount } = render(<App />)
    await screen.findByText(/saved 2 min ago/i)
    expect(screen.getByText(/how to get a board/i).closest('details')).not.toHaveAttribute('open')
    unmount()

    const stale = minutesAgo(45)
    stub({ 'GET /api/board': () => Response.json({ saved_at: stale, projections: 10 }) })
    render(<App />)
    await screen.findByText(/saved 45 min ago/i)
    expect(screen.getByText(/how to get a board/i).closest('details')).toHaveAttribute('open')
  })
})

describe('Run', () => {
  const withBoard = { 'GET /api/board': () => Response.json({ saved_at: minutesAgo(1), projections: 11 }) }

  it('runs with defaults and renders the report', async () => {
    const fetchMock = stub({ ...withBoard, 'POST /api/run': () => Response.json(report) })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))

    const slips = await screen.findByRole('region', { name: /best slips/i })
    expect(within(slips).getByRole('heading', { name: 'Power 2' })).toBeInTheDocument()
    expect(within(slips).getByText('+$1.23')).toBeInTheDocument()

    const legs = screen.getByRole('region', { name: /top legs/i })
    expect(within(legs).getAllByRole('row')).toHaveLength(3) // header + 2 legs
    expect(within(legs).getByText('Over 249.5 Pass Yards')).toBeInTheDocument()

    const unpriced = screen.getByRole('region', { name: /unpriced/i })
    expect(within(unpriced).getByText(/9 lines/i)).toBeInTheDocument()
    expect(within(within(unpriced).getByRole('list')).getByText(/no book line/i)).toBeInTheDocument()

    expect(screen.getByText(/fanduel unavailable/i)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/run', expect.objectContaining({ method: 'POST' }))
  })

  it('shows the engine error when a run fails', async () => {
    stub({
      ...withBoard,
      'POST /api/run': () => Response.json({ detail: 'no sportsbook odds available: draftkings unavailable' }, { status: 422 }),
    })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no sportsbook odds available/i)
  })
})

describe('Run settings', () => {
  const withBoard = { 'GET /api/board': () => Response.json({ saved_at: minutesAgo(1), projections: 11 }) }

  function runBodies(fetchMock: ReturnType<typeof stub>) {
    return fetchMock.mock.calls
      .filter(([url]) => url === '/api/run')
      .map(([, init]) => JSON.parse(String(init!.body)))
  }

  async function ready() {
    const fetchMock = stub({ ...withBoard, 'POST /api/run': () => Response.json(report) })
    render(<App />)
    await screen.findByRole('button', { name: 'NBA', pressed: true })
    return fetchMock
  }

  it('sends the defaults from the engine', async () => {
    const fetchMock = await ready()
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    await screen.findByRole('region', { name: /best slips/i })
    expect(runBodies(fetchMock)).toEqual([
      { sports: ['NFL', 'NBA', 'NHL', 'MLB'], stake: 10, hours: 24, devig: 'multiplicative', ref_slip: null, no_cache: false },
    ])
  })

  it('toggles leagues and needs at least one', async () => {
    const fetchMock = await ready()
    await userEvent.click(screen.getByRole('button', { name: 'NBA' }))
    expect(screen.getByRole('button', { name: 'NBA' })).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    await screen.findByRole('region', { name: /best slips/i })
    expect(runBodies(fetchMock)[0].sports).toEqual(['NFL', 'NHL', 'MLB'])

    for (const s of ['NFL', 'NHL', 'MLB']) await userEvent.click(screen.getByRole('button', { name: s }))
    expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled()
    expect(screen.getByText(/pick at least one league/i)).toBeInTheDocument()
  })

  it('sends stake and the advanced settings', async () => {
    const fetchMock = await ready()
    const stake = screen.getByLabelText(/stake/i)
    await userEvent.clear(stake)
    await userEvent.type(stake, '25')

    await userEvent.click(screen.getByText(/advanced/i))
    const hours = screen.getByLabelText(/hours ahead/i)
    await userEvent.clear(hours)
    await userEvent.type(hours, '6')
    await userEvent.selectOptions(screen.getByLabelText(/devig/i), 'shin')
    await userEvent.selectOptions(screen.getByLabelText(/edge against/i), 'flex6')
    await userEvent.click(screen.getByLabelText(/fresh odds/i))

    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    await screen.findByRole('region', { name: /best slips/i })
    expect(runBodies(fetchMock)[0]).toEqual({
      sports: ['NFL', 'NBA', 'NHL', 'MLB'], stake: 25, hours: 6, devig: 'shin', ref_slip: 'flex6', no_cache: true,
    })
  })

  it('blocks a run with an invalid stake', async () => {
    await ready()
    await userEvent.clear(screen.getByLabelText(/stake/i))
    expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled()
  })

  it('remembers settings across visits, except fresh odds', async () => {
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'MLB' }))
    const stake = screen.getByLabelText(/stake/i)
    await userEvent.clear(stake)
    await userEvent.type(stake, '5')
    await userEvent.click(screen.getByText(/advanced/i))
    await userEvent.selectOptions(screen.getByLabelText(/devig/i), 'power')
    await userEvent.click(screen.getByLabelText(/fresh odds/i))
    cleanup()

    await ready()
    expect(screen.getByRole('button', { name: 'MLB' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText(/stake/i)).toHaveValue(5)
    expect(screen.getByLabelText(/devig/i)).toHaveValue('power')
    expect(screen.getByLabelText(/fresh odds/i)).not.toBeChecked()
  })

  it('ignores remembered settings the engine no longer offers', async () => {
    localStorage.setItem('ppopt.settings.v1', JSON.stringify({ sports: ['XFL', 'NBA'], devig: 'magic', stake: -3 }))
    await ready()
    expect(screen.getByRole('button', { name: 'NFL' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'NBA' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText(/stake/i)).toHaveValue(10)
  })
})

describe('Report controls (no re-run)', () => {
  const withBoard = { 'GET /api/board': () => Response.json({ saved_at: minutesAgo(1), projections: 11 }) }

  async function withReport() {
    const fetchMock = stub({ ...withBoard, 'POST /api/run': () => Response.json(report) })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    await screen.findByRole('region', { name: /best slips/i })
    return fetchMock
  }

  const runs = (f: ReturnType<typeof stub>) => f.mock.calls.filter(([url]) => url === '/api/run').length

  it('filters slips by type and size', async () => {
    const fetchMock = await withReport()
    const slips = screen.getByRole('region', { name: /best slips/i })
    expect(within(slips).getAllByRole('article')).toHaveLength(2)

    await userEvent.click(within(slips).getByRole('button', { name: 'Flex' }))
    expect(within(slips).getByRole('heading', { name: 'Flex 2' })).toBeInTheDocument()
    expect(within(slips).queryByRole('heading', { name: 'Power 2' })).not.toBeInTheDocument()

    await userEvent.click(within(slips).getByRole('button', { name: '3' }))
    expect(within(slips).queryAllByRole('article')).toHaveLength(0)
    expect(within(slips).getByText(/no slips match/i)).toBeInTheDocument()
    expect(runs(fetchMock)).toBe(1)
  })

  it('changes how many legs show', async () => {
    const fetchMock = await withReport()
    await userEvent.click(screen.getByText(/advanced/i))
    const top = screen.getByLabelText(/legs to show/i)
    await userEvent.clear(top)
    await userEvent.type(top, '1')
    const legs = screen.getByRole('region', { name: /top legs/i })
    expect(within(legs).getAllByRole('row')).toHaveLength(2) // header + 1
    expect(runs(fetchMock)).toBe(1)
  })

  it('downloads the report as JSON', async () => {
    await withReport()
    const blobs: Blob[] = []
    URL.createObjectURL = vi.fn((b: Blob) => (blobs.push(b), 'blob:report'))
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await userEvent.click(screen.getByRole('button', { name: /download json/i }))

    expect(click).toHaveBeenCalled()
    const a = click.mock.contexts[0] as HTMLAnchorElement
    expect(a.download).toMatch(/^ppopt-report-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}\.json$/)
    expect(JSON.parse(await blobs[0].text())).toEqual(report)
    click.mockRestore()
  })
})
