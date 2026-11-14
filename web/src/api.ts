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

export class ApiError extends Error {
  /** The HTTP status, when the server answered with one (409: another run is going). */
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return res.json()
  let detail = `HTTP ${res.status}`
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') detail = body.detail
  } catch {
    // keep the status line
  }
  throw new ApiError(detail, res.status)
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

/** Read a run's NDJSON events to its end: the report, or an ApiError with the reason it failed. */
async function follow(res: Response, onProgress: (p: RunProgress) => void, onBoard: (b: BoardInfo) => void): Promise<Report> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
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

/**
 * Run the engine. The server streams NDJSON: progress events, a "board" event once the run has fetched and saved
 * the board, then one "report" or "error".
 * A plain JSON answer (an older server, or an error found before the run started) is handled too. While another run
 * is going the server refuses with 409 (an ApiError with that status).
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
  return follow(res, onProgress, onBoard)
}

/**
 * Watch the run in progress, whoever started it: where it is now (progress, and its board if it has one), then its
 * events to the end. Null when no run is going. Aborting stops watching; the run goes on.
 */
export async function watchRun(
  onProgress: (p: RunProgress) => void,
  onBoard: (b: BoardInfo) => void,
  signal: AbortSignal,
): Promise<Report | null> {
  const res = await fetch('/api/run/live', { headers: { Accept: 'application/x-ndjson' }, signal })
  if (res.status === 204) return null
  if (!res.ok || !res.body) return json(res)
  return follow(res, onProgress, onBoard)
}

/** The run settings every run starts from (GLOSSARY: Run settings), as the server keeps them. */
export interface SavedSettings {
  sports: string[]
  stake: number
  hours: number
  devig: string
  ref_slip: string | null
}

export async function getSettings(): Promise<SavedSettings & { saved: boolean }> {
  return json(await fetch('/api/settings'))
}

export async function putSettings(settings: SavedSettings, keepalive = false): Promise<SavedSettings> {
  return json(
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
      keepalive,
    }),
  )
}

export type StartedBy = 'auto' | 'manual'

export interface AutoState {
  enabled: boolean
  next_run_at: string | null
  /** Why a run switched auto runs off (a failed board fetch); cleared when they're switched on or off by hand. */
  off_reason: string | null
}

export interface Status {
  auto: AutoState
  running: { started_by: StartedBy; started_at: string } | null
  latest: { started_by: StartedBy; started_at: string; finished_at: string; ok: boolean; error: string | null } | null
}

export async function getStatus(): Promise<Status> {
  return json(await fetch('/api/status'))
}

export async function putAuto(enabled: boolean): Promise<AutoState> {
  return json(
    await fetch('/api/auto', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  )
}

/** The latest finished run, as the server recorded it: its report, or why it failed. */
export type LatestRun = { started_by: StartedBy; started_at: string; finished_at: string } & (
  | { report: Report; error?: undefined }
  | { error: string; report?: undefined }
)

export async function getLatest(): Promise<LatestRun | null> {
  const res = await fetch('/api/report/latest')
  if (res.status === 404) return null
  return json(res)
}
