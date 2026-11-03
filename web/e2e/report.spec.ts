import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

// Runs against the e2e container (`make e2e`), whose sportsbook odds come from tests/fixtures/markets.json.
const FIXTURE = new URL('../../tests/fixtures/pp_projections.json', import.meta.url)

/** The fixture board with every game moved to two hours from now, so it falls inside the run window. */
function freshBoard(): Buffer {
  const board = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const start = new Date(Date.now() + 2 * 3600_000).toISOString()
  for (const p of board.data) {
    p.attributes.start_time = start
    p.attributes.end_time = start
  }
  return Buffer.from(JSON.stringify(board))
}

test('drop a board, run with defaults, see the report', async ({ page, request }) => {
  await page.goto('/')
  const run = page.getByRole('button', { name: 'Run', exact: true })

  const before = await request.get('/api/board')
  if (before.status() === 404) {
    await expect(page.getByText('No board yet.')).toBeVisible()
    await expect(run).toBeDisabled()
  }

  await page.getByLabel('Choose board file').setInputFiles({
    name: 'projections.json',
    mimeType: 'application/json',
    buffer: freshBoard(),
  })
  await expect(page.getByText('Board saved just now')).toBeVisible()
  await expect(page.getByText('11 lines')).toBeVisible()

  // The upload persisted to the volume: a reload still shows it.
  await page.reload()
  await expect(page.getByText(/Board saved (just now|1 min ago)/)).toBeVisible()

  await run.click()

  const slips = page.getByRole('region', { name: 'Best Slips' })
  await expect(slips.getByRole('heading', { name: 'Power 2' })).toBeVisible()
  await expect(slips.getByText(/Caleb Williams/).first()).toBeVisible()

  const legs = page.getByRole('region', { name: 'Top Legs' })
  await expect(legs.getByRole('cell', { name: 'Caleb Williams' }).first()).toBeVisible()
  await expect(legs.getByRole('cell', { name: 'CHI vs NE' }).first()).toBeVisible()

  await expect(page.getByRole('region', { name: 'Unpriced' })).toBeVisible()
})
