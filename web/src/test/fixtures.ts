import type { AlertOutcome, AlertsPatch, AlertsView, Leg, Options, Report } from '../api'

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

/** A run as the server names it: its id (null for a run recorded before runs had ids), who started it and when. */
export interface RunInfo {
  id: string | null
  started_by: 'auto' | 'manual'
  started_at: string
}

export interface LatestEntry extends RunInfo {
  finished_at: string
  report?: Report
  error?: string
  alert?: AlertOutcome | null
}

/** The alert settings the server starts with, this browser's time zone already chosen, so opening the page changes
 * nothing. */
export const alertDefaults = (): AlertsView => ({
  server: 'https://ntfy.sh',
  topic: '',
  token_set: false,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  medium: { enabled: true, edge: 0.5, legs: 3 },
  high: { enabled: true, edge: 1, legs: 3 },
  saved: false,
  updated_at: null,
})

let runs = 0
/** A run going on the server, with an id of its own. */
export const runInfo = (started_by: 'auto' | 'manual', started_at: string) => ({ id: `run${++runs}`, started_by, started_at })

/** The event a run's stream opens with: which run it is. */
export const head = (run: RunInfo) => ({ type: 'run', ...run })

/** A whole streamed run: its head, then its report. */
export const streamed = (run: RunInfo, r: Report = report) =>
  new Response([head(run), { type: 'report', report: r }].map((e) => JSON.stringify(e) + '\n').join(''), {
    headers: { 'Content-Type': 'application/x-ndjson' },
  })

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
    /** The connection drops: the network went, or the laptop slept. */
    fail: (e: unknown = new TypeError('network error')) => controller.error(e),
  }
}

/**
 * The server's run settings, auto runs, run in progress and latest run, in memory (src/ppopt/web.py). Its routes
 * go into `routes`; tests change `state` to make things happen elsewhere (another tab, a quarter mark).
 */
export function fakeServer() {
  let saves = 0
  /** When a save happened: later with every save. */
  const stamp = () => new Date(Date.UTC(2026, 10, 14, 12) + ++saves * 1000).toISOString()
  const state = {
    settings: { ...options.defaults, saved: false, updated_at: null } as Record<string, unknown>,
    auto: { enabled: false, next_run_at: null as string | null, off_reason: null as string | null },
    running: null as RunInfo | null,
    latest: null as LatestEntry | null,
    /** Answers GET /api/run/live while `running` is set; 204 otherwise. */
    live: null as (() => Response) | null,
    nextRunAt: localTime(14, 30),
    alerts: alertDefaults(),
    /** Answers POST /api/alerts/test and /api/alerts/check. */
    test: (): Response => Response.json({ sent: true }),
    check: (_topic?: string): Response => Response.json({ state: 'unused', detail: 'no recent messages on this topic' }),
  }
  /** Change some run settings, as PATCH /api/settings does (another tab, say). */
  const patchSettings = (changes: Record<string, unknown>) => {
    state.settings = { ...state.settings, ...changes, saved: true, updated_at: stamp() }
    return state.settings
  }
  /** Change some alert settings, as PATCH /api/alerts does (another tab, say). */
  const patchAlerts = (changes: AlertsPatch) => {
    const { token, medium, high, ...rest } = changes
    const a = state.alerts
    state.alerts = {
      ...a,
      ...rest,
      medium: { ...a.medium, ...medium },
      high: { ...a.high, ...high },
      token_set: token === undefined ? a.token_set : token !== '',
      saved: true,
      updated_at: stamp(),
    }
    return state.alerts
  }
  const table: Record<string, Route> = {
    'GET /api/alerts': () => Response.json(state.alerts),
    'PATCH /api/alerts': (init) => Response.json(patchAlerts(JSON.parse(String(init!.body)))),
    'POST /api/alerts/test': () =>
      state.alerts.topic ? state.test() : Response.json({ detail: 'no ntfy topic set: choose one first' }, { status: 409 }),
    'POST /api/alerts/check': (init) => state.check(JSON.parse(String(init?.body ?? '{}')).topic),
    'GET /api/settings': () => Response.json(state.settings),
    'PUT /api/settings': (init) => {
      state.settings = { ...JSON.parse(String(init!.body)), saved: true, updated_at: stamp() }
      return Response.json(state.settings)
    },
    'PATCH /api/settings': (init) => Response.json(patchSettings(JSON.parse(String(init!.body)))),
    'GET /api/status': () => {
      const l = state.latest
      return Response.json({
        auto: state.auto,
        running: state.running,
        latest: l && {
          id: l.id,
          started_by: l.started_by,
          started_at: l.started_at,
          finished_at: l.finished_at,
          ok: !!l.report,
          error: l.error ?? null,
          alert: l.alert ?? null,
        },
        settings_updated_at: state.settings.updated_at,
        alerts_updated_at: state.alerts.updated_at,
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
  return { state, routes: table, patchSettings, patchAlerts }
}
