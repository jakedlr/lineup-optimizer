import type { AlertsPatch, AlertsView, AlertTier, TierName } from './api'

/**
 * The alert settings as typed into the panel (GLOSSARY: Alert, Alert tier). Numbers stay strings so a half-typed
 * value doesn't fight the input; only valid values are ever saved (`alertChanges`). The access token is not here: the
 * server never sends it back, so it is set and cleared on its own.
 */
export interface TierForm {
  enabled: boolean
  edge: string
  legs: string
}

export interface AlertForm {
  server: string
  topic: string
  /** The IANA time zone alert titles' clock is in; "" while none is chosen (UTC meanwhile). */
  timezone: string
  medium: TierForm
  high: TierForm
}

/** The tiers, the louder first, with the ntfy priority each alerts at. */
export const TIERS: { name: TierName; label: string; priority: number }[] = [
  { name: 'high', label: 'High', priority: 4 },
  { name: 'medium', label: 'Medium', priority: 3 },
]

const TOPIC = /^[-_A-Za-z0-9]{1,64}$/

/** Why a topic can't be saved, or null. "" is fine: no topic, no alerts. */
export const topicProblem = (s: string) =>
  s === '' || TOPIC.test(s) ? null : 'A topic is 1–64 letters, digits, - or _ (no spaces).'

/** Why a server URL can't be saved, or null. */
export function serverProblem(s: string): string | null {
  const problem = 'The server is an http(s) address, e.g. https://ntfy.sh.'
  if (/\s/.test(s)) return problem
  try {
    const url = new URL(s)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || s.includes('?') || s.includes('#'))
      return problem
    return null
  } catch {
    return problem
  }
}

/** A time zone this browser knows by its IANA name, or null. "" is none. */
export function zoneValue(s: string): string | null {
  if (!s.trim()) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s })
    return s
  } catch {
    return null
  }
}

const formatters = new Map<string, Intl.DateTimeFormat | null>() // one per zone; null: this browser can't format it
const labels = new Map<string, { hour: number; label: string }>() // one per zone, as of the hour it was worked out

function offsetFormat(zone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(zone)) {
    try {
      formatters.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }))
    } catch {
      formatters.set(zone, null)
    }
  }
  return formatters.get(zone)!
}

/** A zone as a person names it: its city and its offset from GMT at `at`, "Los Angeles (GMT-8)". */
export function zoneLabel(zone: string, at = new Date()): string {
  const hour = Math.floor(at.getTime() / 3_600_000) // offsets change on the hour at most
  const known = labels.get(zone)
  if (known?.hour === hour) return known.label
  const city = zone.split('/').pop()!.replace(/_/g, ' ')
  const offset = offsetFormat(zone)
    ?.formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value
  const label = offset ? `${city} (${offset})` : city // a zone this browser can't format: its city alone
  labels.set(zone, { hour, label })
  return label
}

/** A time zone to choose: its IANA id, and how it reads. */
export interface ZoneChoice {
  value: string
  label: string
}

/**
 * The time zones to choose from, `here` (this browser's) first, then the rest by name; `current` is among them even
 * when the browser doesn't list it. Empty where the browser can't list zones.
 */
export function zoneChoices(current: string, here: string, at = new Date()): ZoneChoice[] {
  const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  if (!list.length) return []
  const zones = new Set(list)
  if (current) zones.add(current)
  const first = zoneValue(here)
  const rest = [...zones]
    .filter((z) => z !== first)
    .map((z) => ({ value: z, label: zoneLabel(z, at) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return first ? [{ value: first, label: zoneLabel(first, at) }, ...rest] : rest
}

/** An edge threshold in percent (0.1-20, in steps of 0.1), or null. */
export function edgeValue(s: string): number | null {
  const n = Number(s)
  if (s.trim() === '' || !Number.isFinite(n) || n < 0.1 || n > 20) return null
  return Math.abs(n * 10 - Math.round(n * 10)) > 1e-6 ? null : Math.round(n * 10) / 10
}

/** A count of qualifying legs (1-6), or null. */
export function legsValue(s: string): number | null {
  const n = Number(s)
  return s.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 6 ? n : null
}

export const edgeProblem = (s: string) => (edgeValue(s) === null ? 'Edge is 0.1% to 20%, in steps of 0.1.' : null)
export const legsProblem = (s: string) => (legsValue(s) === null ? 'Qualifying legs is a whole number from 1 to 6.' : null)

const tierForm = (t: AlertTier): TierForm => ({ enabled: t.enabled, edge: t.edge.toFixed(1), legs: String(t.legs) })

export const fromServer = (v: AlertsView): AlertForm => ({
  server: v.server,
  topic: v.topic,
  timezone: v.timezone ?? '',
  medium: tierForm(v.medium),
  high: tierForm(v.high),
})

type Field = 'server' | 'topic' | 'timezone' | `${TierName}.${keyof AlertTier}`
const FIELDS: Field[] = ['server', 'topic', 'timezone', ...TIERS.flatMap(({ name }) => (['enabled', 'edge', 'legs'] as const).map((k) => `${name}.${k}` as const))]

const split = (f: Field) => f.split('.') as [TierName, keyof AlertTier]

/** The form's value for a field as the server would hold it, or undefined while it isn't valid. */
function formValue(form: AlertForm, f: Field): string | number | boolean | undefined {
  if (f === 'server') return serverProblem(form.server) ? undefined : form.server.replace(/\/+$/, '')
  if (f === 'topic') return topicProblem(form.topic) ? undefined : form.topic
  if (f === 'timezone') return zoneValue(form.timezone) ?? undefined
  const [tier, key] = split(f)
  const t = form[tier]
  if (key === 'enabled') return t.enabled
  return (key === 'edge' ? edgeValue(t.edge) : legsValue(t.legs)) ?? undefined
}

function heldValue(v: AlertsView, f: Field) {
  if (f === 'server' || f === 'topic' || f === 'timezone') return v[f]
  const [tier, key] = split(f)
  return v[tier][key]
}

/** The valid fields of the form that differ from what the server holds, as a PATCH sends them; null when none. */
export function alertChanges(form: AlertForm, held: AlertsView): AlertsPatch | null {
  const changes: Record<string, unknown> = {}
  for (const f of FIELDS) {
    const v = formValue(form, f)
    if (v === undefined || v === heldValue(held, f)) continue
    if (f === 'server' || f === 'topic' || f === 'timezone') changes[f] = v
    else {
      const [tier, key] = split(f)
      changes[tier] = { ...(changes[tier] as object | undefined), [key]: v }
    }
  }
  return Object.keys(changes).length ? (changes as AlertsPatch) : null
}

/**
 * `form` with the alert settings the server now holds, except fields edited here away from `before` (what it held
 * when this page last heard): an edit made here wins for that field only. With no `before`, all come from the server.
 */
export function mergeAlerts(form: AlertForm, before: AlertsView | null, server: AlertsView): AlertForm {
  const fresh = fromServer(server)
  const none = (f: Field) => f === 'timezone' && !form.timezone && before?.timezone === null // none chosen, none held
  const mine = (f: Field) => before !== null && formValue(form, f) !== heldValue(before, f) && !none(f)
  const tier = (name: TierName): TierForm => ({
    enabled: mine(`${name}.enabled`) ? form[name].enabled : fresh[name].enabled,
    edge: mine(`${name}.edge`) ? form[name].edge : fresh[name].edge,
    legs: mine(`${name}.legs`) ? form[name].legs : fresh[name].legs,
  })
  return {
    server: mine('server') ? form.server : fresh.server,
    topic: mine('topic') ? form.topic : fresh.topic,
    timezone: mine('timezone') ? form.timezone : fresh.timezone,
    medium: tier('medium'),
    high: tier('high'),
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const FAIR = 252 // the largest multiple of 36 a byte reaches: bytes from here on would favour a-d

/** A topic that is hard to guess: "pp-" and 12 characters drawn evenly from a-z and 0-9 by the crypto source. */
export function randomTopic(fill: (a: Uint8Array<ArrayBuffer>) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  let out = ''
  while (out.length < 12) {
    for (const b of fill(new Uint8Array(16))) if (b < FAIR && out.length < 12) out += ALPHABET[b % 36]
  }
  return `pp-${out}`
}

/** An edge bar as a leg's edge reads: "≥ +1.0%". */
export const bar = (points: number) => `≥ +${points.toFixed(1)}%`

/** What meets a tier, in words; "Off" when it's switched off; null while its values aren't valid. */
export function tierSummary(t: TierForm): string | null {
  if (!t.enabled) return 'Off'
  const edge = edgeValue(t.edge)
  const legs = legsValue(t.legs)
  if (edge === null || legs === null) return null
  return `${legs === 1 ? '1 game' : `${legs} or more games`} with a leg ${bar(edge)}`
}

/** Medium's bar above high's while both are on: medium would rarely sound before high does. */
export function barsCrossed(form: AlertForm): boolean {
  const medium = edgeValue(form.medium.edge)
  const high = edgeValue(form.high.edge)
  return form.medium.enabled && form.high.enabled && medium !== null && high !== null && medium > high
}

/** Where to subscribe to the topic: ntfy's web app page for it, which its phone app also opens. */
export const subscribeUrl = (server: string, topic: string) => `${server.replace(/\/+$/, '')}/${topic}`
