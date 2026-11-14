import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const FIXTURE = new URL('../../tests/fixtures/pp_projections.json', import.meta.url)
// Mounted into the e2e container as its partner feed (docker-compose.e2e.yml, PPOPT_BOARD_FILE).
const FEED_DIR = new URL('./.feed/', import.meta.url)
const FEED = new URL('projections.json', FEED_DIR)

/** The fixture board with every game moved to two hours from now, so it falls inside the run window. */
export function freshBoard(): Buffer {
  const board = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const start = new Date(Date.now() + 2 * 3600_000).toISOString()
  for (const p of board.data) p.attributes.start_time = p.attributes.end_time = start
  return Buffer.from(JSON.stringify(board))
}

/** The partner feed serves the fresh fixture board. Written aside and renamed, so a fetch never reads half of it. */
export function writeFeed() {
  mkdirSync(FEED_DIR, { recursive: true })
  const tmp = new URL('projections.json.tmp', FEED_DIR)
  writeFileSync(tmp, freshBoard())
  renameSync(tmp, FEED)
}

/** The partner feed is down: every fetch fails. */
export function removeFeed() {
  rmSync(FEED, { force: true })
}

/** Upload a board through the page's fallback. */
export const boardFile = () => ({ name: 'projections.json', mimeType: 'application/json', buffer: freshBoard() })
