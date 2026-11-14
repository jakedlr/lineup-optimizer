import type { Leg, Options, Report } from '../api'

export function leg(over: Partial<Leg> = {}): Leg {
  return {
    sport: 'NFL',
    game: 'NFL:CHI-NE',
    matchup: 'CHI vs NE',
    player: 'Drake Maye',
    side: 'over',
    line: 249.5,
    stat: 'pass_yards',
    stat_label: 'Pass Yards',
    prob: 0.623,
    books: { draftkings: 0.62, fanduel: 0.626 },
    disagreement: 0.006,
    promo_type: '',
    modelled: false,
    ...over,
  }
}

const maye = leg({ edge: 0.05, same_game: false })
const embiid = leg({
  sport: 'NBA',
  game: 'NBA:CLE-PHI',
  matchup: 'CLE vs PHI',
  player: 'Joel Embiid',
  line: 35.5,
  stat: 'pts_rebs_asts',
  stat_label: 'Pts+Rebs+Asts',
  prob: 0.581,
  books: { draftkings: 0.581 },
  edge: 0.008,
  same_game: false,
  promo_type: 'taco',
})

export const report: Report = {
  settings: { sports: ['NFL', 'NBA', 'NHL', 'MLB'], hours: 24, stake: 10, devig: 'multiplicative', mode: 'cash' },
  ref_slip: { type: 'power', size: 2, break_even: 0.5735 },
  legs: [maye, embiid],
  slips: [
    { type: 'power', size: 2, ev: 1.23, ev_pct: 0.123, legs: [maye, embiid] },
    { type: 'flex', size: 2, ev: -0.4, ev_pct: -0.04, legs: [maye, embiid] },
  ],
  unmatched: { 'no book line': 7, 'unmapped stat': 2 },
  unmatched_lines: [
    { sport: 'NFL', player: 'Rome Odunze', stat: 'Receiving Yards', line: 48.5, reason: 'no book line' },
  ],
  warnings: ['fanduel unavailable: HTTP 403'],
  live_requests: 14,
  timing: {
    seconds: 31.24,
    books: {
      draftkings: { requests: 14, cached: 0, failed: false, seconds: 30.08 },
      fanduel: { requests: 0, cached: 9, failed: false, seconds: 0.02 },
    },
    summary: 'Run took 31.2s: DraftKings 14 live requests in 30.1s, FanDuel from the odds cache (as the engine words it)',
  },
}

type Route = (init?: RequestInit) => Response | Promise<Response>

/** Stub fetch with one handler per "METHOD /path"; unknown routes fail the test loudly. */
export function routes(table: Record<string, Route>) {
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    const handler = table[key]
    if (!handler) throw new Error(`unexpected fetch: ${key}`)
    return handler(init)
  }
  return fn
}

export const options: Options = {
  sports: ['NFL', 'NBA', 'NHL', 'MLB'],
  devig: ['worst', 'multiplicative', 'additive', 'power', 'shin'],
  ref_slips: ['power2', 'power3', 'power4', 'power5', 'power6', 'flex2', 'flex3', 'flex4', 'flex5', 'flex6'],
  defaults: { sports: ['NFL', 'NBA', 'NHL', 'MLB'], hours: 24, stake: 10, devig: 'worst', ref_slip: null },
  board_app_url: 'https://api.prizepicks.com/projections?per_page=1000&single_stat=true&game_mode=pickem',
}

/** An ISO time for today at this local clock time, so a label reads the same in any time zone. */
export const localTime = (h: number, m: number) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

export interface LatestEntry {
  started_by: 'auto' | 'manual'
  started_at: string
  finished_at: string
  report?: Report
  error?: string
}

/** NDJSON run events fed by hand, one chunk at a time. */
export function controlledRun() {
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

/**
 * The server's run settings, auto runs, run in progress and latest run, in memory (src/ppopt/web.py). Its routes
 * go into `routes`; tests change `state` to make things happen elsewhere (another tab, a quarter mark).
 */
export function fakeServer() {
  const state = {
    settings: { ...options.defaults, saved: false } as Record<string, unknown>,
    auto: { enabled: false, next_run_at: null as string | null, off_reason: null as string | null },
    running: null as { started_by: 'auto' | 'manual'; started_at: string } | null,
    latest: null as LatestEntry | null,
    /** Answers GET /api/run/live while `running` is set; 204 otherwise. */
    live: null as (() => Response) | null,
    nextRunAt: localTime(14, 30),
  }
  const table: Record<string, Route> = {
    'GET /api/settings': () => Response.json(state.settings),
    'PUT /api/settings': (init) => {
      state.settings = { ...JSON.parse(String(init!.body)), saved: true }
      return Response.json(state.settings)
    },
    'GET /api/status': () => {
      const l = state.latest
      return Response.json({
        auto: state.auto,
        running: state.running,
        latest: l && { started_by: l.started_by, started_at: l.started_at, finished_at: l.finished_at, ok: !!l.report, error: l.error ?? null },
      })
    },
    'GET /api/report/latest': () =>
      state.latest ? Response.json(state.latest) : Response.json({ detail: 'no run has finished yet' }, { status: 404 }),
    'PUT /api/auto': (init) => {
      const { enabled } = JSON.parse(String(init!.body))
      state.auto = { enabled, next_run_at: enabled ? state.nextRunAt : null, off_reason: null }
      return Response.json(state.auto)
    },
    'GET /api/run/live': () => (state.running && state.live ? state.live() : new Response(null, { status: 204 })),
  }
  return { state, routes: table }
}
