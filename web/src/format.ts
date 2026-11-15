import type { Leg } from './api'

export const STALE_MINUTES = 30

export function minutesSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
}

export function ago(minutes: number): string {
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const h = Math.floor(minutes / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`

/** The sign of `x` as printed at `digits` decimals (after scaling): 0 when it rounds to zero, so a "$0.00" is never red. */
export function signOf(x: number, digits: number, scale = 1): -1 | 0 | 1 {
  const r = Math.round(Math.abs(x * scale) * 10 ** digits)
  return r === 0 ? 0 : x > 0 ? 1 : -1
}

/** A change in percent: "+14.9%", "−2.1%", and an unsigned "0.0%". */
export const signedPct = (x: number) => {
  const s = signOf(x, 1, 100)
  return `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)}%`
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', signDisplay: 'exceptZero' })
const USD_WHOLE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const USD_CENTS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** An EV in dollars: "+$1,234.50", "−$0.40", and an unsigned "$0.00". */
export const signedMoney = (x: number) => USD.format(signOf(x, 2) === 0 ? 0 : x).replace('-', '−')

/** A stake: "$1,000", or "$7.50" when it has cents. */
export const money = (x: number) => (Number.isInteger(x) ? USD_WHOLE : USD_CENTS).format(x)

/** An engine message as a sentence: its first letter capitalised. */
export const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Time gone by, as a clock reads it: "0:07", "2:05". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` // taste-skill-ignore: a clock time
}

export const pick = (leg: Pick<Leg, 'side' | 'line' | 'stat_label'>) =>
  `${leg.side === 'over' ? 'Over' : 'Under'} ${leg.line} ${leg.stat_label}`

const BOOK_ABBR: Record<string, string> = { draftkings: 'DK', fanduel: 'FD' }
export const bookAbbr = (book: string) => BOOK_ABBR[book] ?? book

/** A slip's name as the report heads it: "Power 2", "Flex 5". */
export const slipName = (slip: { type: 'power' | 'flex'; size: number }) =>
  `${slip.type === 'power' ? 'Power' : 'Flex'} ${slip.size}`

/** A local 24-hour clock time, "14:15". */
export function clock(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` // taste-skill-ignore: a clock time
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A local time with as much of its day as it needs: "09:12" today, "Wed 09:12" within the last week, "3 Nov 09:12"
 * before that (or on a day ahead of this clock), "30 Dec 2025 18:05" in another year.
 */
export function dayClock(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const midnight = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const daysBack = Math.round((midnight(now) - midnight(d)) / 86_400_000) // rounded: a DST day is 23 or 25 h
  if (daysBack === 0) return clock(iso)
  if (daysBack > 0 && daysBack < 7) return `${DAYS[d.getDay()]} ${clock(iso)}`
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${clock(iso)}`
}

/**
 * How a report or failure is marked: "Auto run · 14:15", "Run · 14:08"; a report no longer the latest word is the
 * "Previous run · 14:08", "Previous auto run · 14:15".
 */
export const runLabel = (startedBy: 'auto' | 'manual', startedAt: string, previous = false) =>
  `${previous ? 'Previous ' : ''}${startedBy === 'auto' ? (previous ? 'auto run' : 'Auto run') : previous ? 'run' : 'Run'} · ${clock(startedAt)}`
