import { expect, run, test } from './test.ts'

// Promo legs are picked from the saved board; the page has one (fetched from the canned partner feed, or uploaded
// by the fallback specs that ran first).
test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Board' }).getByText('11 lines')).toBeVisible()
})

test('a promo leg picked from the board is priced into the report', async ({ page }) => {
  const promotion = page.getByRole('group', { name: 'Promotion' })
  await promotion.getByRole('button', { name: 'Promo legs' }).click()

  await page.getByLabel('Find a line on the board').fill('embiid')
  await page.getByRole('option', { name: /Joel Embiid/ }).first().click()
  await page.getByLabel('Promo line', { exact: true }).fill('30.5')
  await page.getByRole('button', { name: 'Add promo leg' }).click()
  await expect(page.getByRole('list', { name: 'Promo legs' })).toContainText('Joel Embiid · Over 30.5 Pts+Rebs+Asts')

  await run(page)
  const legs = page.getByRole('region', { name: 'Top Legs' })
  const row = legs.getByRole('row').filter({ hasText: 'Over 30.5 Pts+Rebs+Asts' })
  await expect(row).toContainText('manual')
})

test('bonus entry runs Power slips only', async ({ page }) => {
  await page.getByRole('group', { name: 'Promotion' }).getByRole('button', { name: 'Bonus entry' }).click()
  await run(page)
  await expect(page.getByText(/· bonus ·/)).toBeVisible()
  const slips = page.getByRole('region', { name: 'Best Slips' })
  await expect(slips.getByRole('heading', { name: /^Power/ }).first()).toBeVisible()
  await expect(slips.getByRole('heading', { name: /^Flex/ })).toHaveCount(0)
})
