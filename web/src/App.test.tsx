import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { options, report, routes } from './test/fixtures'

const health = () => Response.json({ status: 'ok' })
const noBoard = () => Response.json({ detail: 'no board yet' }, { status: 404 })
const feedDown = () =>
  Response.json({ detail: "couldn't fetch the board from PrizePicks' partner feed: HTTP 503 from partner-api" }, { status: 502 })
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

function stub(table: Parameters<typeof routes>[0]) {
  const fn = vi.fn(
    routes({
      'GET /api/health': health,
      'GET /api/options': () => Response.json(options),
      'POST /api/board/fetch': feedDown,
      ...table,
    }),
  )
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
  // saved_at is fixed before the page mounts, so "N min ago" can't round down to N-1
  const saved = (source: string) => (m: number, projections = 11) => {
    const saved_at = minutesAgo(m)
    return () => Response.json({ saved_at, projections, source })
  }
  const fetched = saved('fetched')
  const uploaded = saved('uploaded')
  const fetchCalls = (fetchMock: ReturnType<typeof stub>) => fetchMock.mock.calls.filter(([url]) => url === '/api/board/fetch')
  const fallback = () => screen.getByText(/board fetch failing\? upload one instead/i).closest('details')!

  it('with no board, fetches one on opening, quietly, then says where it came from', async () => {
    let answer!: (r: Response) => void
    const fetchMock = stub({
      'GET /api/board': noBoard,
      'POST /api/board/fetch': () => new Promise<Response>((r) => (answer = r)),
    })
    render(<App />)
    expect(await screen.findByText(/fetching board/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    answer(Response.json({ saved_at: minutesAgo(0), projections: 30207, source: 'fetched' }))
    expect(await screen.findByText(/fetched just now/i)).toBeInTheDocument()
    expect(screen.getByText(/30,207 lines/)).toBeInTheDocument()
    expect(screen.queryByText(/fetching board/i)).not.toBeInTheDocument()
    expect(fetchCalls(fetchMock)).toHaveLength(1)
    expect(fallback()).not.toHaveAttribute('open')
  })

  it('shows a fresh fetched board and how old it is, without fetching again', async () => {
    const fetchMock = stub({ 'GET /api/board': fetched(5, 1234) })
    render(<App />)
    expect(await screen.findByText(/fetched 5 min ago/i)).toBeInTheDocument()
    expect(screen.getByText(/1,234 lines/i)).toBeInTheDocument()
    expect(screen.queryByText(/lines may have moved/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^run$/i })).toBeEnabled()
    expect(fetchCalls(fetchMock)).toHaveLength(0)
  })

  it('says when the board was uploaded instead', async () => {
    stub({ 'GET /api/board': uploaded(12) })
    render(<App />)
    expect(await screen.findByText(/uploaded 12 min ago/i)).toBeInTheDocument()
  })

  it('fetches a fresh board on opening when the saved one is stale', async () => {
    const fetchMock = stub({
      'GET /api/board': uploaded(45),
      'POST /api/board/fetch': () => Response.json({ saved_at: minutesAgo(0), projections: 12, source: 'fetched' }),
    })
    render(<App />)
    expect(await screen.findByText(/fetched just now/i)).toBeInTheDocument()
    expect(fetchCalls(fetchMock)).toHaveLength(1)
    expect(screen.queryByText(/lines may have moved/i)).not.toBeInTheDocument()
  })

  it('when the fetch fails on a stale board, flags it, says why, and opens the upload fallback', async () => {
    stub({ 'GET /api/board': uploaded(45) })
    render(<App />)
    expect(await screen.findByText(/HTTP 503 from partner-api/)).toBeInTheDocument()
    expect(screen.getByText(/uploaded 45 min ago/i)).toBeInTheDocument()
    expect(screen.getByText(/lines may have moved/i)).toBeInTheDocument()
    expect(fallback()).toHaveAttribute('open')
  })

  it('with no board and a failing fetch, says why, opens the upload fallback, and still lets you run', async () => {
    stub({ 'GET /api/board': noBoard })
    render(<App />)
    expect(await screen.findByText(/couldn't fetch the board from PrizePicks' partner feed: HTTP 503/i)).toBeInTheDocument()
    expect(screen.getByText(/no board yet/i)).toBeInTheDocument()
    expect(fallback()).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: /^run$/i })).toBeEnabled()
  })

  it('locks the upload while the board is being fetched', async () => {
    stub({ 'GET /api/board': noBoard, 'POST /api/board/fetch': () => new Promise<Response>(() => {}) })
    render(<App />)
    await screen.findByText(/fetching board/i)
    expect(screen.getByLabelText(/choose board file/i)).toBeDisabled()
  })

  it('uploads a chosen file and shows the new board', async () => {
    const fetchMock = stub({
      'GET /api/board': noBoard,
      'PUT /api/board': () => Response.json({ saved_at: minutesAgo(0), projections: 11, source: 'uploaded' }),
    })
    render(<App />)
    await screen.findByText(/HTTP 503/)

    const file = new File(['{"data":[]}'], 'projections.json', { type: 'application/json' })
    await userEvent.upload(screen.getByLabelText(/choose board file/i), file)

    expect(await screen.findByText(/uploaded just now/i)).toBeInTheDocument()
    expect(screen.queryByText(/HTTP 503/)).not.toBeInTheDocument()
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!
    expect((put[1]!.body as FormData).get('file')).toBe(file)
  })

  it('shows why an upload was rejected', async () => {
    stub({
      'GET /api/board': noBoard,
      'PUT /api/board': () => Response.json({ detail: "that file isn't a PrizePicks projections feed" }, { status: 422 }),
    })
    render(<App />)
    await screen.findByText(/HTTP 503/)
    await userEvent.upload(screen.getByLabelText(/choose board file/i), new File(['x'], 'x.json'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/isn't a PrizePicks projections feed/i)
  })

  it('refreshes the board after a run, since the run saved a fresh one', async () => {
    let boards = 0
    const before = fetched(20)
    stub({
      'GET /api/board': () => (boards++ === 0 ? before() : fetched(0, 13)()),
      'POST /api/run': () => Response.json(report),
    })
    render(<App />)
    await screen.findByText(/fetched 20 min ago/i)
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    expect(await screen.findByText(/fetched just now/i)).toBeInTheDocument()
    expect(screen.getByText(/13 lines/)).toBeInTheDocument()
  })
})

describe('Board upload fallback', () => {
  it('links to the app feed the engine names, opening in a new tab', async () => {
    stub({ 'GET /api/board': noBoard })
    render(<App />)
    await screen.findByText(/HTTP 503/)
    const link = screen.getByRole('link', { name: /api\.prizepicks\.com\/projections/i })
    expect(link).toHaveAttribute('href', options.board_app_url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByRole('link', { name: /app\.prizepicks\.com/i })).toHaveAttribute('href', 'https://app.prizepicks.com')
  })

  it('is tucked away while the board is usable', async () => {
    const saved_at = minutesAgo(2)
    stub({ 'GET /api/board': () => Response.json({ saved_at, projections: 10, source: 'fetched' }) })
    render(<App />)
    await screen.findByText(/fetched 2 min ago/i)
    expect(screen.getByText(/board fetch failing\? upload one instead/i).closest('details')).not.toHaveAttribute('open')
  })
})

describe('Run', () => {
  it('shows what a run will produce before the first one', async () => {
    stub({ 'GET /api/board': () => Response.json({ saved_at: minutesAgo(1), projections: 11, source: 'fetched' }), 'POST /api/run': () => Response.json(report) })
    render(<App />)
    const empty = await screen.findByRole('region', { name: /no report yet/i })
    expect(empty).toHaveTextContent(/best slips, top legs/i)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    await screen.findByRole('region', { name: /best slips/i })
    expect(screen.queryByRole('region', { name: /no report yet/i })).not.toBeInTheDocument()
  })

  const withBoard = { 'GET /api/board': () => Response.json({ saved_at: minutesAgo(1), projections: 11, source: 'fetched' }) }

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
    expect(
      screen.getByText('Run took 31.2s: DraftKings 14 live requests in 30.1s, FanDuel from the odds cache (as the engine words it)'),
    ).toBeInTheDocument()
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
  const withBoard = { 'GET /api/board': () => Response.json({ saved_at: minutesAgo(1), projections: 11, source: 'fetched' }) }

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
      {
        sports: ['NFL', 'NBA', 'NHL', 'MLB'], stake: 10, hours: 24, devig: 'worst', ref_slip: null, no_cache: false,
        bonus: false, boost: null, promo_legs: [], feed_promos: true,
      },
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
      bonus: false, boost: null, promo_legs: [], feed_promos: true,
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

  it('opens on worst-case devig, with the four methods selectable', async () => {
    await ready()
    await userEvent.click(screen.getByText(/advanced/i))
    const devig = screen.getByLabelText(/devig/i)
    expect(devig).toHaveValue('worst')
    expect(within(devig).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Worst case (lowest of four)', 'multiplicative', 'additive', 'power', 'shin',
    ])
  })

  it('moves a devig saved before worst case was the default onto worst case, once', async () => {
    localStorage.setItem('ppopt.settings.v1', JSON.stringify({ devig: 'multiplicative', stake: '7' }))
    await ready()
    expect(screen.getByLabelText(/devig/i)).toHaveValue('worst')
    expect(screen.getByLabelText(/stake/i)).toHaveValue(7)

    await userEvent.click(screen.getByText(/advanced/i))
    await userEvent.selectOptions(screen.getByLabelText(/devig/i), 'multiplicative')
    cleanup()

    await ready()
    expect(screen.getByLabelText(/devig/i)).toHaveValue('multiplicative')
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
  const withBoard = { 'GET /api/board': () => Response.json({ saved_at: minutesAgo(1), projections: 11, source: 'fetched' }) }

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

describe('Promotions', () => {
  const withBoard = { 'GET /api/board': () => Response.json({ saved_at: minutesAgo(1), projections: 11, source: 'fetched' }) }
  const LINES = 'GET /api/board/lines?sports=NFL%2CNBA%2CNHL%2CMLB&hours=24'
  const boardLines = [
    { sport: 'NBA', matchup: 'CLE vs PHI', player: 'Joel Embiid', stat_label: 'Points', line: 27.5 },
    { sport: 'NBA', matchup: 'CLE vs PHI', player: 'Joel Embiid', stat_label: 'Pts+Rebs+Asts', line: 35.5 },
    { sport: 'NFL', matchup: 'CHI vs NE', player: 'Drake Maye', stat_label: 'Pass Yards', line: 249.5 },
  ]

  async function ready() {
    const fetchMock = stub({
      ...withBoard,
      [LINES]: () => Response.json(boardLines),
      'POST /api/run': () => Response.json(report),
    })
    render(<App />)
    await screen.findByRole('button', { name: 'NBA', pressed: true })
    return fetchMock
  }

  const promotion = () => screen.getByRole('group', { name: /promotion/i })

  async function runBody(fetchMock: ReturnType<typeof stub>) {
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    await screen.findByRole('region', { name: /best slips/i })
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/run')!
    return JSON.parse(String(call[1]!.body))
  }

  it('defaults to none, with feed promos on', async () => {
    await ready()
    expect(within(promotion()).getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText(/promo lines from the board/i)).toBeChecked()
  })

  it('sends a bonus entry and sets feed promos aside', async () => {
    const fetchMock = await ready()
    await userEvent.click(within(promotion()).getByRole('button', { name: /bonus/i }))
    expect(screen.getByLabelText(/promo lines from the board/i)).toBeDisabled()
    const body = await runBody(fetchMock)
    expect(body).toMatchObject({ bonus: true, boost: null, promo_legs: [], feed_promos: false })
  })

  it('sends a boost, and needs it above 1', async () => {
    const fetchMock = await ready()
    await userEvent.click(within(promotion()).getByRole('button', { name: /boost/i }))
    const boost = screen.getByLabelText(/boost ×/i)
    await userEvent.clear(boost)
    await userEvent.type(boost, '1')
    expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled()
    expect(screen.getByText(/boost must be more than 1/i)).toBeInTheDocument()

    await userEvent.clear(boost)
    await userEvent.type(boost, '1.4')
    expect(await runBody(fetchMock)).toMatchObject({ bonus: false, boost: 1.4, promo_legs: [], feed_promos: false })
  })

  it('can leave out feed promos', async () => {
    const fetchMock = await ready()
    await userEvent.click(screen.getByLabelText(/promo lines from the board/i))
    expect(await runBody(fetchMock)).toMatchObject({ feed_promos: false })
  })

  it('builds promo legs from the board', async () => {
    const fetchMock = await ready()
    await userEvent.click(within(promotion()).getByRole('button', { name: /promo legs/i }))
    expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled()
    expect(screen.getByText(/add a promo leg/i)).toBeInTheDocument()

    await userEvent.type(await screen.findByLabelText(/find a line/i), 'embiid pts')
    const results = screen.getByRole('listbox', { name: /board lines/i })
    expect(within(results).getAllByRole('option')).toHaveLength(1)
    await userEvent.click(within(results).getByRole('option', { name: /joel embiid.*pts\+rebs\+asts.*35\.5/i }))

    const line = screen.getByLabelText('Promo line')
    expect(line).toHaveValue(35.5)
    await userEvent.clear(line)
    await userEvent.type(line, '30.5')
    await userEvent.click(screen.getByRole('button', { name: /add promo leg/i }))

    const added = screen.getByRole('list', { name: /promo legs/i })
    expect(within(added).getByText(/joel embiid/i)).toHaveTextContent(/over 30\.5 pts\+rebs\+asts/i)

    expect(await runBody(fetchMock)).toMatchObject({
      bonus: false,
      boost: null,
      promo_legs: [
        { sport: 'NBA', matchup: 'CLE vs PHI', player: 'Joel Embiid', stat_label: 'Pts+Rebs+Asts', side: 'over', line: 30.5 },
      ],
    })
  })

  it('needs a half-point promo line and can remove a leg', async () => {
    await ready()
    await userEvent.click(within(promotion()).getByRole('button', { name: /promo legs/i }))
    await userEvent.type(await screen.findByLabelText(/find a line/i), 'maye')
    await userEvent.click(screen.getByRole('option', { name: /drake maye/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Under' }))
    const line = screen.getByLabelText('Promo line')
    await userEvent.clear(line)
    await userEvent.type(line, '260')
    expect(screen.getByRole('button', { name: /add promo leg/i })).toBeDisabled()
    expect(screen.getByText(/half-point/i)).toBeInTheDocument()

    await userEvent.clear(line)
    await userEvent.type(line, '260.5')
    await userEvent.click(screen.getByRole('button', { name: /add promo leg/i }))
    const added = screen.getByRole('list', { name: /promo legs/i })
    expect(within(added).getByText(/drake maye/i)).toHaveTextContent(/under 260\.5 pass yards/i)

    await userEvent.click(within(added).getByRole('button', { name: /remove/i }))
    expect(screen.queryByRole('list', { name: /promo legs/i })).not.toBeInTheDocument()
  })

  it('is not remembered', async () => {
    await ready()
    await userEvent.click(within(promotion()).getByRole('button', { name: /bonus/i }))
    await userEvent.click(screen.getByRole('button', { name: 'MLB' })) // a remembered change, to force a save
    cleanup()
    await ready()
    expect(within(promotion()).getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('Run progress', () => {
  const withBoard = { 'GET /api/board': () => Response.json({ saved_at: minutesAgo(1), projections: 11, source: 'fetched' }) }

  /** A run response we feed by hand, one chunk at a time. */
  function controlledRun() {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
    const enc = new TextEncoder()
    return {
      response: () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }),
      send: (text: string) => controller.enqueue(enc.encode(text)),
      event: (e: object) => controller.enqueue(enc.encode(JSON.stringify(e) + '\n')),
      close: () => controller.close(),
    }
  }

  async function start() {
    const run = controlledRun()
    const fetchMock = stub({ ...withBoard, 'POST /api/run': run.response })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    return { run, fetchMock }
  }

  it('asks the engine to stream progress', async () => {
    const { run, fetchMock } = await start()
    const init = fetchMock.mock.calls.find(([url]) => url === '/api/run')![1]!
    expect(new Headers(init.headers).get('Accept')).toBe('application/x-ndjson')
    run.close()
  })

  it('shows a progress bar with a percentage and the current step', async () => {
    const { run } = await start()
    const bar = await screen.findByRole('progressbar', { name: /run progress/i })
    expect(bar).toHaveAttribute('aria-valuenow', '0')

    run.event({ type: 'progress', done: 4, total: 10, step: 'DraftKings NBA' })
    await screen.findByText('40%')
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByText(/draftkings nba/i)).toBeInTheDocument()
    expect(screen.getByText(/4 of 10 requests/i)).toBeInTheDocument()

    run.event({ type: 'progress', done: 5, total: 20, step: 'FanDuel NBA' }) // plan grew: never step backwards
    await screen.findByText(/fanduel nba/i)
    expect(bar).toHaveAttribute('aria-valuenow', '40')

    run.event({ type: 'report', report })
    run.close()
    expect(await screen.findByRole('region', { name: /best slips/i })).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('shows the fetched board as soon as the run has it, before the report', async () => {
    const run = controlledRun()
    stub({
      'GET /api/board': () => Response.json({ saved_at: minutesAgo(20), projections: 11, source: 'uploaded' }),
      'POST /api/run': run.response,
    })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    expect(await screen.findByText(/uploaded 1\d min ago/i)).toBeInTheDocument()

    run.event({ type: 'progress', done: 0, total: 0, step: 'Fetching the PrizePicks board' })
    run.event({ type: 'board', board: { saved_at: minutesAgo(0), projections: 30253, source: 'fetched' } })
    expect(await screen.findByText(/30,253 lines/)).toBeInTheDocument()
    expect(screen.getByText(/^fetched/i)).toBeInTheDocument()
    expect(screen.queryByText(/uploaded 1\d min ago/i)).not.toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: /run progress/i })).toBeInTheDocument() // still running
    run.close()
  })

  it('copes with events split across chunks', async () => {
    const { run } = await start()
    const line = JSON.stringify({ type: 'progress', done: 1, total: 4, step: 'FanDuel NFL' }) + '\n'
    run.send(line.slice(0, 20))
    run.send(line.slice(20) + JSON.stringify({ type: 'report', report }).slice(0, 50))
    await screen.findByText('25%')
    run.send(JSON.stringify({ type: 'report', report }).slice(50) + '\n')
    run.close()
    expect(await screen.findByRole('region', { name: /best slips/i })).toBeInTheDocument()
  })

  it('shows an error sent mid-run', async () => {
    const { run } = await start()
    run.event({ type: 'progress', done: 1, total: 4, step: 'DraftKings NFL' })
    run.event({ type: 'error', detail: 'no sportsbook odds available: draftkings unavailable: HTTP 403' })
    run.close()
    expect(await screen.findByRole('alert')).toHaveTextContent(/draftkings unavailable/i)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('says so if the stream ends without a report', async () => {
    const { run } = await start()
    run.event({ type: 'progress', done: 1, total: 4, step: 'DraftKings NFL' })
    run.close()
    expect(await screen.findByRole('alert')).toHaveTextContent(/ended before/i)
  })
})

describe('Theme', () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme
  })

  it('follows the system by default and can be forced light or dark, remembered', async () => {
    stub({ 'GET /api/board': noBoard })
    render(<App />)
    const theme = screen.getByRole('group', { name: /theme/i })
    expect(within(theme).getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement.dataset.theme).toBeUndefined()

    await userEvent.click(within(theme).getByRole('button', { name: 'Dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('ppopt.theme')).toBe('dark')

    await userEvent.click(within(theme).getByRole('button', { name: 'System' }))
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(localStorage.getItem('ppopt.theme')).toBeNull()
  })

  it('starts from the remembered theme', async () => {
    localStorage.setItem('ppopt.theme', 'light')
    stub({ 'GET /api/board': noBoard })
    render(<App />)
    expect(within(screen.getByRole('group', { name: /theme/i })).getByRole('button', { name: 'Light' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('Review fixes', () => {
  const withBoard = { 'GET /api/board': () => Response.json({ saved_at: minutesAgo(1), projections: 11, source: 'fetched' }) }
  const LINES = 'GET /api/board/lines?sports=NFL%2CNBA%2CNHL%2CMLB&hours=24'
  const boardLines = [{ sport: 'NBA', matchup: 'CLE vs PHI', player: 'Joel Embiid', stat_label: 'Pts+Rebs+Asts', line: 35.5 }]

  async function addEmbiidPromo() {
    await userEvent.click(within(screen.getByRole('group', { name: /promotion/i })).getByRole('button', { name: /promo legs/i }))
    await userEvent.type(await screen.findByLabelText(/find a line/i), 'embiid')
    await userEvent.click(screen.getByRole('option', { name: /joel embiid/i }))
    await userEvent.click(screen.getByRole('button', { name: /add promo leg/i }))
    await screen.findByRole('list', { name: /promo legs/i })
  }

  it('locks the board while a run is going, so an old run cannot report over a new board', async () => {
    stub({ ...withBoard, 'POST /api/run': () => new Promise<Response>(() => {}) })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    expect(screen.getByRole('button', { name: /replace board/i })).toBeDisabled()
    expect(screen.getByLabelText(/choose board file/i)).toBeDisabled()
  })

  it('blocks a run whose promo leg is in a league that is not selected', async () => {
    stub({ ...withBoard, [LINES]: () => Response.json(boardLines), 'GET /api/board/lines?sports=NFL%2CNHL%2CMLB&hours=24': () => Response.json([]) })
    render(<App />)
    await screen.findByRole('button', { name: 'NBA', pressed: true })
    await addEmbiidPromo()
    await userEvent.click(screen.getByRole('button', { name: 'NBA' }))
    expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled()
    expect(screen.getByText(/joel embiid is an nba promo leg/i)).toBeInTheDocument()
  })

  it('clears promo legs when a new board is uploaded', async () => {
    stub({
      ...withBoard,
      [LINES]: () => Response.json(boardLines),
      'PUT /api/board': () => Response.json({ saved_at: new Date().toISOString(), projections: 9, source: 'uploaded' }),
    })
    render(<App />)
    await screen.findByRole('button', { name: 'NBA', pressed: true })
    await addEmbiidPromo()
    await userEvent.upload(screen.getByLabelText(/choose board file/i), new File(['{"data":[]}'], 'b.json'))
    await screen.findByText(/uploaded just now/i)
    expect(screen.queryByRole('list', { name: /promo legs/i })).not.toBeInTheDocument()
  })

  it('treats a fractional or zero "legs to show" as the default', async () => {
    stub({ ...withBoard, 'POST /api/run': () => Response.json(report) })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^run$/i }))
    await screen.findByRole('region', { name: /top legs/i })
    await userEvent.click(screen.getByText(/advanced/i))
    const top = screen.getByLabelText(/legs to show/i)
    for (const bad of ['0.5', '0']) {
      await userEvent.clear(top)
      await userEvent.type(top, bad)
      expect(within(screen.getByRole('region', { name: /top legs/i })).getAllByRole('row')).toHaveLength(3)
    }
  })
})
