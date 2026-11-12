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
}
