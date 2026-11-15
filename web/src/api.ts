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

/** A run that ended in failure: the reason is the run's own (its "error" event). */
export class RunFailed extends ApiError {
  /** Stopped rather than failed: cancelled (its starter went away) or the app shut down (src/ppopt/runs.py). */
  get stopped() {
    return this.message.startsWith('the run was stopped')
  }
}

/** A run's stream was cut off before its end arrived (the network went, the laptop slept): the run may go on. */
export class StreamDropped extends Error {}

/** An error, as the page words it. */
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

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

export type StartedBy = 'auto' | 'manual'

/** Which run this is: the event every run stream opens with, and how /api/status names a run going. */
export interface RunHead {
  id: string
  started_by: StartedBy
  started_at: string
}

type RunEvent =
  | ({ type: 'run' } & RunHead)
  | ({ type: 'progress' } & RunProgress)
  | { type: 'board'; board: BoardInfo }
  | { type: 'report'; report: Report }
  | { type: 'error'; detail: string }

export interface RunListener {
  onRun?: (run: RunHead) => void
  onProgress?: (p: RunProgress) => void
  onBoard?: (b: BoardInfo) => void
}

/**
 * Read a run's NDJSON events to its end: the report, RunFailed with the reason it failed, or StreamDropped when the
 * stream ends (or breaks) before either arrives.
 */
async function follow(res: Response, on: RunListener): Promise<Report> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    let chunk: ReadableStreamReadResult<string>
    try {
      chunk = await reader.read()
    } catch {
      throw new StreamDropped('The connection to the engine dropped before the run ended.')
    }
    const { value, done } = chunk
    if (value) buffer += value
    const lines = buffer.split('\n')
    buffer = done ? '' : lines.pop()!
    for (const line of lines) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as RunEvent
      if (event.type === 'run') on.onRun?.({ id: event.id, started_by: event.started_by, started_at: event.started_at })
      else if (event.type === 'progress') on.onProgress?.({ done: event.done, total: event.total, step: event.step })
      else if (event.type === 'board') on.onBoard?.(event.board)
      else if (event.type === 'report') return event.report
      else throw new RunFailed(event.detail)
    }
    if (done) throw new StreamDropped('The run ended before the engine sent a report. Check the container logs.')
  }
}

/**
 * Run the engine. The server streams NDJSON: a "run" event naming the run, progress events, a "board" event once the
 * run has fetched and saved the board, then one "report" or "error". Closing the stream cancels the run.
 * A plain JSON answer (an older server, or an error found before the run started) is handled too. While another run
 * is going the server refuses with 409 (an ApiError with that status).
 */
export async function runReport(settings: RunSettings, on: RunListener = {}): Promise<Report> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(settings),
  })
  if (!res.ok || !res.headers.get('Content-Type')?.includes('ndjson') || !res.body) return json(res)
  return follow(res, on)
}

/**
 * Watch the run in progress, whoever started it: which run it is, where it is now (progress, and its board if it has
 * one), then its events to the end. Null when no run is going. Aborting stops watching; the run goes on. Anything
 * short of the run's end, bar aborting, is StreamDropped.
 */
export async function watchRun(on: RunListener, signal: AbortSignal): Promise<Report | null> {
  let res: Response
  try {
    res = await fetch('/api/run/live', { headers: { Accept: 'application/x-ndjson' }, signal })
  } catch (e) {
    if (signal.aborted) throw e
    throw new StreamDropped(message(e))
  }
  if (res.status === 204) return null
  if (!res.ok || !res.body) throw new StreamDropped(`HTTP ${res.status}`)
  return follow(res, on)
}

/** The run settings every run starts from (GLOSSARY: Run settings), as the server keeps them. */
export interface SavedSettings {
  sports: string[]
  stake: number
  hours: number
  devig: string
  ref_slip: string | null
}

/** The run settings as the server answers: whether they were ever saved, and when they last were. */
export interface ServerSettings extends SavedSettings {
  saved: boolean
  updated_at: string | null
}

export async function getSettings(): Promise<ServerSettings> {
  return json(await fetch('/api/settings'))
}

/** Change some run settings, keeping the rest as the server holds them. Answers with all of them. */
export async function patchSettings(changes: Partial<SavedSettings>, keepalive = false): Promise<ServerSettings> {
  return json(
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
      keepalive,
    }),
  )
}

export interface AutoState {
  enabled: boolean
  next_run_at: string | null
  /** Why a run switched auto runs off (a failed board fetch); cleared when they're switched on or off by hand. */
  off_reason: string | null
}

/** A run the server has recorded. Its id is null when it was recorded before runs had ids. */
export interface RecordedRun {
  id: string | null
  started_by: StartedBy
  started_at: string
  finished_at: string
}

/** How an auto run's alert went (GLOSSARY: Alert). */
export interface AlertOutcome {
  sent: boolean
  /** Null when there was no alert to send (it couldn't be made): `error` says why. */
  priority: number | null
  title: string | null
  /** Why ntfy refused it, couldn't be reached, or there was no alert to send; null when sent. */
  error: string | null
}

export interface Status {
  auto: AutoState
  running: RunHead | null
  /** `alert` is null for a manual run, an auto run with no topic set, and an auto run whose alert is still going. */
  latest: (RecordedRun & { ok: boolean; error: string | null; alert?: AlertOutcome | null }) | null
  /** When the run settings were last saved (null: never). */
  settings_updated_at: string | null
  /** When the alert settings were last saved (null: never). */
  alerts_updated_at?: string | null
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

/** The latest finished run, as the server recorded it: its report, or why it failed; and how its alert went (null for a
 * manual run, an auto run with no topic set, and an auto run whose alert is still going). */
export type LatestRun = RecordedRun & { alert?: AlertOutcome | null } & (
  | { report: Report; error?: undefined }
  | { error: string; report?: undefined }
)

export async function getLatest(): Promise<LatestRun | null> {
  const res = await fetch('/api/report/latest')
  if (res.status === 404) return null
  return json(res)
}

/** An alert tier (GLOSSARY: Alert tier): met when `legs` games' best legs reach `edge` (percentage points, shown as %). */
export interface AlertTier {
  enabled: boolean
  edge: number
  legs: number
}

export type TierName = 'high' | 'medium'

/** The alert settings as the server shows them: never the access token, only whether there is one. */
export interface AlertsView {
  server: string
  /** "" is no topic: auto runs send no alerts. */
  topic: string
  token_set: boolean
  /** The time zone alert titles' clock is in (IANA); null until one is chosen, UTC meanwhile. */
  timezone: string | null
  medium: AlertTier
  high: AlertTier
  saved: boolean
  updated_at: string | null
}

/** Some alert settings to change; a tier may be changed in part, and a token of "" clears it. */
export interface AlertsPatch {
  server?: string
  topic?: string
  token?: string
  timezone?: string
  medium?: Partial<AlertTier>
  high?: Partial<AlertTier>
}

export async function getAlerts(): Promise<AlertsView> {
  return json(await fetch('/api/alerts'))
}

export async function patchAlerts(changes: AlertsPatch, keepalive = false): Promise<AlertsView> {
  return json(
    await fetch('/api/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
      keepalive,
    }),
  )
}

/** Send a test alert to the saved topic. Fails with the reason: no topic (409), or ntfy refused it or is down (502). */
export async function sendTestAlert(): Promise<void> {
  await json(await fetch('/api/alerts/test', { method: 'POST' }))
}

export type TopicState = 'unused' | 'recent' | 'reserved' | 'unknown'

/** Advice on whether a topic (by default the saved one) looks free to use. */
export async function checkTopic(topic?: string): Promise<{ state: TopicState; detail: string }> {
  return json(
    await fetch('/api/alerts/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(topic ? { topic } : {}),
    }),
  )
}
