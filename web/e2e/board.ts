import { execFileSync } from 'node:child_process'
import { constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
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
export function writeFeed(feed: URL = FEED, board: () => Buffer = freshBoard) {
  mkdirSync(new URL('./', feed), { recursive: true })
  const tmp = new URL(`${feed.pathname.split('/').pop()}.tmp`, feed)
  writeFileSync(tmp, board())
  renameSync(tmp, feed)
}

/** The partner feed is down: every fetch fails. */
export function removeFeed() {
  rmSync(FEED, { force: true })
}

/** Upload a board through the page's fallback. */
export const boardFile = () => ({ name: 'projections.json', mimeType: 'application/json', buffer: freshBoard() })

/** How long release waits on a fetch that has opened the pipe but stopped reading it. */
const DRAIN_MS = 30_000

/**
 * The partner feed hangs: the feed file is a named pipe, so a fetch waits on it until `release()` hands it the fresh
 * board (and puts the plain file back). Lets a spec watch a run that is still going. Always release, even when the
 * spec fails: a run left waiting holds every run after it.
 */
export function holdFeed(feed: URL = FEED, board: () => Buffer = freshBoard): () => Promise<void> {
  mkdirSync(new URL('./', feed), { recursive: true })
  rmSync(feed, { force: true })
  execFileSync('mkfifo', [fileURLToPath(feed)])
  return async () => {
    try {
      // Non-blocking: when nothing is reading the pipe (no fetch got that far), there's nobody to hand the board to.
      const pipe = await open(feed, constants.O_WRONLY | constants.O_NONBLOCK)
      try {
        await drainInto(pipe, board())
      } finally {
        await pipe.close()
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENXIO') throw e
    } finally {
      writeFeed(feed, board)
    }
  }
}

/** Write all of `data` to a non-blocking pipe, waiting whenever it's full (64 KB) for the reader to drain it. */
async function drainInto(pipe: FileHandle, data: Buffer) {
  const deadline = Date.now() + DRAIN_MS
  for (let at = 0; at < data.length; ) {
    try {
      at += (await pipe.write(data, at)).bytesWritten
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e
      if (Date.now() > deadline) throw new Error(`the fetch stopped reading the held feed after ${at} bytes`)
      await new Promise((r) => setTimeout(r, 5))
    }
  }
}
