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
  /** Sportsbook requests the run made live, not answered from the odds cache. 0 means a cached run. */
  live_requests: number
  /** How long the run took, and how each sportsbook was reached; `summary` is the engine's one-line wording. */
  timing: {
    seconds: number
    books: Record<string, { requests: number; cached: number; failed: boolean; seconds: number }>
    summary: string
  }
}

export interface BoardInfo {
  saved_at: string
  projections: number
  /** Where the board came from: PrizePicks' partner feed, or a file uploaded as the fallback. */
  source: 'fetched' | 'uploaded'
}

export interface Options {
  sports: string[]
  devig: string[]
  ref_slips: string[]
  defaults: { sports: string[]; hours: number; stake: number; devig: string; ref_slip: string | null }
  /** The PrizePicks app's feed, for saving a board by hand when the fetch fails. */
  board_app_url: string
}

export interface BoardLine {
  sport: string
  matchup: string
  player: string
  stat_label: string
  line: number
}

export interface PromoLeg extends BoardLine {
  side: Side
}

export interface RunSettings {
  sports: string[]
  stake: number
  hours: number
  devig: string
  ref_slip: string | null
  no_cache: boolean
  bonus: boolean
  boost: number | null
  promo_legs: PromoLeg[]
  feed_promos: boolean
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

/** Fetch the board from PrizePicks' partner feed and save it. Fails with the reason when the feed can't be read. */
export async function fetchBoard(): Promise<BoardInfo> {
  return json(await fetch('/api/board/fetch', { method: 'POST' }))
}

export async function putBoard(file: File): Promise<BoardInfo> {
  const body = new FormData()
  body.append('file', file)
  return json(await fetch('/api/board', { method: 'PUT', body }))
}

export async function getBoardLines(sports: string[], hours: number): Promise<BoardLine[]> {
  const query = new URLSearchParams({ sports: sports.join(','), hours: String(hours) })
  return json(await fetch(`/api/board/lines?${query}`))
}

export async function getOptions(): Promise<Options> {
  return json(await fetch('/api/options'))
}

export interface RunProgress {
  done: number
  total: number
  step: string
}

type RunEvent =
  | ({ type: 'progress' } & RunProgress)
  | { type: 'board'; board: BoardInfo }
  | { type: 'report'; report: Report }
  | { type: 'error'; detail: string }

/**
 * Run the engine. The server streams NDJSON: progress events, a "board" event once the run has fetched and saved
 * the board, then one "report" or "error".
 * A plain JSON answer (an older server, or an error found before the run started) is handled too.
 */
export async function runReport(
  settings: RunSettings,
  onProgress: (p: RunProgress) => void = () => {},
  onBoard: (b: BoardInfo) => void = () => {},
): Promise<Report> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(settings),
  })
  if (!res.ok || !res.headers.get('Content-Type')?.includes('ndjson') || !res.body) return json(res)

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buffer += value
    const lines = buffer.split('\n')
    buffer = done ? '' : lines.pop()!
    for (const line of lines) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as RunEvent
      if (event.type === 'progress') onProgress({ done: event.done, total: event.total, step: event.step })
      else if (event.type === 'board') onBoard(event.board)
      else if (event.type === 'report') return event.report
      else throw new ApiError(event.detail)
    }
    if (done) throw new ApiError('The run ended before the engine sent a report. Check the container logs.')
  }
}
