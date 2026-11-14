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

export const signedPct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`

export const signedDollars = (x: number) => `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(2)}`

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

/** How a report or failure is marked: "Auto run · 14:15", "Run · 14:08". */
export const runLabel = (startedBy: 'auto' | 'manual', startedAt: string) =>
  `${startedBy === 'auto' ? 'Auto run' : 'Run'} · ${clock(startedAt)}`
