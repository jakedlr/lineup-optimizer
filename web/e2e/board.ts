import { execFileSync } from 'node:child_process'
import { constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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

/**
 * The partner feed hangs: the feed file is a named pipe, so a fetch waits on it until `release()` hands it the fresh
 * board (and puts the plain file back). Lets a spec watch a run that is still going. Always release, even when the
 * spec fails: a run left waiting holds every run after it.
 */
export function holdFeed(): () => Promise<void> {
  mkdirSync(FEED_DIR, { recursive: true })
  rmSync(FEED, { force: true })
  execFileSync('mkfifo', [fileURLToPath(FEED)])
  return async () => {
    try {
      // Non-blocking: when nothing is reading the pipe (no fetch got that far), there's nobody to hand the board to.
      const pipe = await open(FEED, constants.O_WRONLY | constants.O_NONBLOCK)
      try {
        await pipe.writeFile(freshBoard())
      } finally {
        await pipe.close()
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENXIO') throw e
    } finally {
      writeFeed()
    }
  }
}
