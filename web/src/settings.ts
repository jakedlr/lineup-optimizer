import type { Options, PromoLeg, RunSettings, SavedSettings } from './api'

/**
 * Everything the user can set, as typed into the form. Numbers stay strings so a half-typed value
 * ("1.") doesn't fight the input; `toRun` turns them into a request once they're valid.
 * The run settings (sports, stake, hours, devig, refSlip) live on the server, shared with auto runs (`toSaved`,
 * `fromServer`); the rest are view preferences, kept in this browser (`save`).
 * Fresh odds (`no_cache`) and promotions are deliberately not part of this: one-offs, never remembered.
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

/**
 * What this browser saved, keeping only values the engine still accepts. Since Sprint 9 that's only the view
 * preferences; a browser from before then also has run settings, copied to the server once (`hasOldRunSettings`).
 */
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

const RUN_KEYS = ['sports', 'stake', 'hours', 'devig', 'refSlip']

/** Whether this browser still has run settings saved before they moved to the server. */
export function hasOldRunSettings(): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return !!saved && typeof saved === 'object' && RUN_KEYS.some((k) => k in saved)
  } catch {
    return false
  }
}

/** Save the view preferences in this browser (and only them: any old run settings saved here go). */
export function save(s: Settings) {
  const { top, slipType, slipSize, notify } = s
  try {
    localStorage.setItem(KEY, JSON.stringify({ top, slipType, slipSize, notify }))
  } catch {
    // private mode or storage full: preferences just won't be remembered
  }
}

/** `base` with the run settings the server holds, keeping only values the engine offers. */
export function fromServer(saved: SavedSettings, o: Options, base: Settings): Settings {
  const sports = o.sports.filter((s) => saved.sports.includes(s))
  return {
    ...base,
    sports: sports.length ? sports : base.sports,
    stake: String(saved.stake),
    hours: String(saved.hours),
    devig: o.devig.includes(saved.devig) ? saved.devig : base.devig,
    refSlip: saved.ref_slip && o.ref_slips.includes(saved.ref_slip) ? saved.ref_slip : '',
  }
}

/** The run settings to save on the server, or null while any of them isn't valid (half-typed, or no league). */
export function toSaved(s: Settings): SavedSettings | null {
  const stake = positive(s.stake)
  const hours = positive(s.hours)
  if (s.sports.length === 0 || stake === null || hours === null) return null
  return { sports: s.sports, stake, hours, devig: s.devig, ref_slip: s.refSlip || null }
}

type RunKey = keyof SavedSettings
const RUN_FIELDS: RunKey[] = ['sports', 'stake', 'hours', 'devig', 'ref_slip']

/** The form's value for one run setting, or undefined while it isn't valid (half-typed, or no league). */
function formValue(s: Settings, k: RunKey): SavedSettings[RunKey] | undefined {
  switch (k) {
    case 'sports':
      return s.sports.length ? s.sports : undefined
    case 'stake':
      return positive(s.stake) ?? undefined
    case 'hours':
      return positive(s.hours) ?? undefined
    case 'devig':
      return s.devig
    case 'ref_slip':
      return s.refSlip || null
  }
}

const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? [...a].sort().join() === [...b].sort().join() : a === b

/** The run settings in the form that differ from what the server holds: valid ones only, as a PATCH sends them. */
export function runChanges(s: Settings, held: SavedSettings): Partial<SavedSettings> {
  const changes: Partial<Record<RunKey, unknown>> = {}
  for (const k of RUN_FIELDS) {
    const v = formValue(s, k)
    if (v !== undefined && !same(v, held[k])) changes[k] = v
  }
  return changes as Partial<SavedSettings>
}

/**
 * `s` with the run settings the server now holds, except those edited here away from `before` (what it held when this
 * page last heard): an edit made here wins for that setting only. With no `before`, all come from the server.
 */
export function mergeServer(s: Settings, before: SavedSettings | null, server: SavedSettings, o: Options): Settings {
  const fresh = fromServer(server, o, s)
  const mine = (k: RunKey) => before !== null && !same(formValue(s, k), before[k])
  return {
    ...fresh,
    sports: mine('sports') ? s.sports : fresh.sports,
    stake: mine('stake') ? s.stake : fresh.stake,
    hours: mine('hours') ? s.hours : fresh.hours,
    devig: mine('devig') ? s.devig : fresh.devig,
    refSlip: mine('ref_slip') ? s.refSlip : fresh.refSlip,
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

/** A setting that can hold a run back, and so where the page says why. */
export type ProblemField = 'sports' | 'stake' | 'hours' | 'promotion'

/** Why these settings can't be run yet: the setting at fault, and the words for it. */
export interface Problem {
  field: ProblemField
  text: string
}

/** Is `r` the reason a run can't go, rather than the request? */
export const isProblem = (r: RunSettings | Problem): r is Problem => 'field' in r && 'text' in r

/** The request for these settings, or the reason they can't be run yet. */
export function toRun(s: Settings, noCache: boolean, promo: Promotion = NO_PROMOTION): RunSettings | Problem {
  if (s.sports.length === 0) return { field: 'sports', text: 'Pick at least one league.' }
  const stake = positive(s.stake)
  if (stake === null) return { field: 'stake', text: 'Stake must be more than $0.' }
  const hours = positive(s.hours)
  if (hours === null) return { field: 'hours', text: 'Hours ahead must be more than 0.' }

  const held = (text: string): Problem => ({ field: 'promotion', text })
  let boost: number | null = null
  if (promo.kind === 'boost') {
    boost = positive(promo.boost)
    if (boost === null || boost <= 1) return held('Boost must be more than 1 (e.g. 1.4).')
  }
  if (promo.kind === 'legs' && promo.legs.length === 0) return held('Add a promo leg, or set Promos to None.')
  if (promo.kind === 'legs') {
    const off = promo.legs.find((l) => !s.sports.includes(l.sport))
    if (off) return held(`${off.player} is an ${off.sport} promo leg, but ${off.sport} isn't selected.`)
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
