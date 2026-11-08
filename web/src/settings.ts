import type { Options, PromoLeg, RunSettings } from './api'

/**
 * Everything the user can set, as typed into the form. Numbers stay strings so a half-typed value
 * ("1.") doesn't fight the input; `toRun` turns them into a request once they're valid.
 * Fresh odds (`no_cache`) is deliberately not part of this: it's a one-off, never remembered.
 * Promotions (Sprint 3) won't be either.
 */
export interface Settings {
  sports: string[]
  stake: string
  hours: string
  devig: string
  refSlip: string // '' = engine default (lowest break-even)
  top: string
  slipType: 'all' | 'power' | 'flex'
  slipSize: 'all' | number
  notify: boolean // system notifications for runs that end in a hidden tab
}

const KEY = 'ppopt.settings.v1'
/** Marks settings saved since worst-case devig became the default; older saves had multiplicative by default. */
const DEVIG_DEFAULT = 'worst'
export const DEFAULT_TOP = 25

export function defaults(o: Options): Settings {
  return {
    sports: o.defaults.sports,
    stake: String(o.defaults.stake),
    hours: String(o.defaults.hours),
    devig: o.defaults.devig,
    refSlip: o.defaults.ref_slip ?? '',
    top: String(DEFAULT_TOP),
    slipType: 'all',
    slipSize: 'all',
    notify: false,
  }
}

/** A whole number of 1 or more, or null. */
export const count = (s: string) => {
  const n = Number(s)
  return s.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : null
}

export const positive = (s: string) => {
  const n = Number(s)
  return s.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
}

/** Saved settings, keeping only values the engine still accepts. */
export function load(o: Options): Settings {
  const base = defaults(o)
  let saved: Record<string, unknown> = {}
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
  } catch {
    return base
  }
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null)
  const sports = Array.isArray(saved.sports) ? o.sports.filter((s) => (saved.sports as unknown[]).includes(s)) : []
  const pos = (v: unknown) => (str(v) !== null && positive(str(v)!) !== null ? str(v)! : null)
  return {
    sports: sports.length ? sports : base.sports,
    stake: pos(saved.stake) ?? base.stake,
    hours: pos(saved.hours) ?? base.hours,
    devig:
      saved.devigDefault === DEVIG_DEFAULT && o.devig.includes(saved.devig as string) ? (saved.devig as string) : base.devig,
    refSlip: o.ref_slips.includes(saved.refSlip as string) ? (saved.refSlip as string) : base.refSlip,
    top: str(saved.top) !== null && count(str(saved.top)!) !== null ? str(saved.top)! : base.top,
    slipType: ['all', 'power', 'flex'].includes(saved.slipType as string) ? (saved.slipType as Settings['slipType']) : 'all',
    slipSize: [2, 3, 4, 5, 6].includes(saved.slipSize as number) ? (saved.slipSize as number) : 'all',
    notify: saved.notify === true,
  }
}

export function save(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, devigDefault: DEVIG_DEFAULT }))
  } catch {
    // private mode or storage full: settings just won't be remembered
  }
}

/** One promotion per run, as on the CLI. Lives only in memory: never remembered. */
export interface Promotion {
  kind: 'none' | 'bonus' | 'boost' | 'legs'
  boost: string
  legs: PromoLeg[]
  feedPromos: boolean
}

export const NO_PROMOTION: Promotion = { kind: 'none', boost: '1.5', legs: [], feedPromos: true }

export type Problem = string | null

/** The request for these settings, or the reason they can't be run yet. */
export function toRun(s: Settings, noCache: boolean, promo: Promotion = NO_PROMOTION): RunSettings | Problem {
  if (s.sports.length === 0) return 'Pick at least one league.'
  const stake = positive(s.stake)
  if (stake === null) return 'Stake must be more than $0.'
  const hours = positive(s.hours)
  if (hours === null) return 'Hours ahead must be more than 0.'

  let boost: number | null = null
  if (promo.kind === 'boost') {
    boost = positive(promo.boost)
    if (boost === null || boost <= 1) return 'Boost must be more than 1 (e.g. 1.4).'
  }
  if (promo.kind === 'legs' && promo.legs.length === 0) return 'Add a promo leg, or set Promotion to None.'
  if (promo.kind === 'legs') {
    const off = promo.legs.find((l) => !s.sports.includes(l.sport))
    if (off) return `${off.player} is an ${off.sport} promo leg, but ${off.sport} isn't selected.`
  }
  const feedPromosApply = promo.kind !== 'bonus' && promo.kind !== 'boost'

  return {
    sports: s.sports,
    stake,
    hours,
    devig: s.devig,
    ref_slip: s.refSlip || null,
    no_cache: noCache,
    bonus: promo.kind === 'bonus',
    boost,
    promo_legs: promo.kind === 'legs' ? promo.legs : [],
    feed_promos: promo.feedPromos && feedPromosApply, // the engine drops them under a bonus or boost anyway
  }
}
