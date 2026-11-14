import { test, expect } from '@playwright/test'
import { constants, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { holdFeed } from './board.ts'

// `holdFeed()` itself (e2e/board.ts), on a pipe of its own: no app involved. A real board runs to megabytes, far
// past the 64 KB a pipe holds, so release must keep writing as the reader drains it.

const PIPE_BUFFER = 64 * 1024
const bigBoard = () =>
  Buffer.from(JSON.stringify({ data: Array.from({ length: 6000 }, (_, i) => ({ id: String(i), pad: 'x'.repeat(60) })) }))

let dir: string
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ppopt-feed-'))
})
test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('release hands a waiting fetch the whole board, however big, then puts the plain file back', async () => {
  const feed = pathToFileURL(join(dir, 'projections.json'))
  const board = bigBoard()
  expect(board.length).toBeGreaterThan(4 * PIPE_BUFFER)
  const release = holdFeed(feed, () => board)
  expect(statSync(feed).isFIFO()).toBe(true)

  // A fetch waiting on the pipe, as the app's is: a reader that's there before release, and slower than the writer
  // (it starts draining only once the pipe is full).
  const reader = new Socket({ fd: openSync(feed, constants.O_RDONLY | constants.O_NONBLOCK), readable: true, writable: false })
  reader.pause()
  const chunks: Buffer[] = []
  reader.on('data', (c: Buffer) => chunks.push(c))
  const ended = once(reader, 'end')

  const released = release()
  setTimeout(() => reader.resume(), 300)
  await released
  await ended
  expect(Buffer.concat(chunks).equals(board)).toBe(true)
  expect(statSync(feed).isFile()).toBe(true)
  expect(readFileSync(feed).equals(board)).toBe(true)
})

test('release with nothing reading returns at once and puts the plain file back', async () => {
  const feed = pathToFileURL(join(dir, 'projections.json'))
  const board = bigBoard()
  const release = holdFeed(feed, () => board)
  await release()
  expect(statSync(feed).isFile()).toBe(true)
  expect(readFileSync(feed).equals(board)).toBe(true)
})
