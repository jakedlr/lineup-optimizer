import type { Report } from './api'
import { signedPct, slipName } from './format'

/** How a run ended: with a report, or with the reason it failed. */
export type RunOutcome = { ok: true; report: Report } | { ok: false; error: string }

/** What a run notification says (GLOSSARY: Run notification). */
export interface RunNotice {
  kind: 'finished' | 'failed'
  title: string
  body: string
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * The notification a run raises, or null when it raises none. A finished fresh run and any failed run
 * notify; a cached run (every sportsbook request answered from the odds cache) does not.
 */
export function runNotice(outcome: RunOutcome): RunNotice | null {
  if (!outcome.ok) return { kind: 'failed', title: 'Run failed', body: outcome.error }
  const { report } = outcome
  if (report.live_requests === 0) return null
  if (report.slips.length === 0) {
    return { kind: 'finished', title: 'Run finished', body: `No slips · ${plural(report.legs.length, 'leg')} priced` }
  }
  const best = report.slips.reduce((a, b) => (b.ev_pct > a.ev_pct ? b : a))
  return {
    kind: 'finished',
    title: 'Run finished',
    body: `${plural(report.slips.length, 'slip')} · best ${signedPct(best.ev_pct)} EV (${slipName(best)})`,
  }
}
