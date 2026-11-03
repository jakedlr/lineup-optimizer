import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const FIXTURE = new URL('../../tests/fixtures/pp_projections.json', import.meta.url)

function freshBoard(): Buffer {
  const board = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const start = new Date(Date.now() + 2 * 3600_000).toISOString()
  for (const p of board.data) p.attributes.start_time = p.attributes.end_time = start
  return Buffer.from(JSON.stringify(board))
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Choose board file').setInputFiles({
    name: 'projections.json', mimeType: 'application/json', buffer: freshBoard(),
  })
  await expect(page.getByText('Board saved just now')).toBeVisible()
})

test('a promo leg picked from the board is priced into the report', async ({ page }) => {
  const promotion = page.getByRole('group', { name: 'Promotion' })
  await promotion.getByRole('button', { name: 'Promo legs' }).click()

  await page.getByLabel('Find a line on the board').fill('embiid')
  await page.getByRole('option', { name: /Joel Embiid/ }).first().click()
  await page.getByLabel('Promo line', { exact: true }).fill('30.5')
  await page.getByRole('button', { name: 'Add promo leg' }).click()
  await expect(page.getByRole('list', { name: 'Promo legs' })).toContainText('Joel Embiid · Over 30.5 Pts+Rebs+Asts')

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  const legs = page.getByRole('region', { name: 'Top Legs' })
  const row = legs.getByRole('row').filter({ hasText: 'Over 30.5 Pts+Rebs+Asts' })
  await expect(row).toContainText('manual')
})

test('bonus entry runs Power slips only', async ({ page }) => {
  await page.getByRole('group', { name: 'Promotion' }).getByRole('button', { name: 'Bonus entry' }).click()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/· bonus ·/)).toBeVisible()
  const slips = page.getByRole('region', { name: 'Best Slips' })
  await expect(slips.getByRole('heading', { name: /^Power/ }).first()).toBeVisible()
  await expect(slips.getByRole('heading', { name: /^Flex/ })).toHaveCount(0)
})
