/** Shapes returned by the ppopt engine (see src/ppopt/cli.py `run`). */

export type Side = 'over' | 'under'

export interface Leg {
  sport: string
  game: string
  matchup: string
  player: string
  side: Side
  line: number
  stat: string
  stat_label: string
  prob: number
  books: Record<string, number>
  disagreement: number
  promo_type: string
  modelled: boolean
  edge?: number
  same_game?: boolean
}

export interface Slip {
  type: 'power' | 'flex'
  size: number
  ev: number
  ev_pct: number
  legs: Leg[]
}

export interface UnpricedLine {
  sport: string
  player: string
  stat: string
  line: number
  reason: string
}

export interface Report {
  settings: { sports: string[]; hours: number; stake: number; devig: string; mode: string }
  ref_slip: { type: string; size: number; break_even: number }
  legs: Leg[]
  slips: Slip[]
  unmatched: Record<string, number>
  unmatched_lines: UnpricedLine[]
  warnings: string[]
}

export interface BoardInfo {
  saved_at: string
  projections: number
}

export class ApiError extends Error {}

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return res.json()
  let detail = `HTTP ${res.status}`
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') detail = body.detail
  } catch {
    // keep the status line
  }
  throw new ApiError(detail)
}

export async function getBoard(): Promise<BoardInfo | null> {
  const res = await fetch('/api/board')
  if (res.status === 404) return null
  return json(res)
}

export async function putBoard(file: File): Promise<BoardInfo> {
  const body = new FormData()
  body.append('file', file)
  return json(await fetch('/api/board', { method: 'PUT', body }))
}

export async function runReport(): Promise<Report> {
  return json(await fetch('/api/run', { method: 'POST' }))
}
