import type { RunProgress } from './api'

export interface Shown extends RunProgress {
  percent: number
}

/** Percent of planned sportsbook requests done. Never moves backwards when a book's plan grows. */
export function advance(prev: Shown | null, next: RunProgress): Shown {
  const percent = next.total > 0 ? Math.floor((next.done / next.total) * 100) : 0
  return { ...next, percent: Math.max(prev?.percent ?? 0, Math.min(percent, 100)) }
}
