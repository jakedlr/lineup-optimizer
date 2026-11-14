import { expect, test } from '@playwright/test'

// Runs against the e2e container (`make e2e`): sportsbook odds come from tests/fixtures/markets.json and the partner
// feed serves the fixture board (e2e/board.ts).

test('the board comes from the partner feed, and a run uses it (reused within a minute of the fetch) and reports on it', async ({ page, request }) => {
  const fetched = await request.post('/api/board/fetch')
  expect(fetched.status()).toBe(200)
  expect(await fetched.json()).toMatchObject({ source: 'fetched', projections: 11 })

  await page.goto('/')
  const panel = page.getByRole('region', { name: 'Board' })
  await expect(panel.getByText(/Fetched (just now|1 min ago)/)).toBeVisible()
  await expect(panel.getByText('11 lines')).toBeVisible()
  await expect(panel.locator('details')).not.toHaveAttribute('open') // the upload fallback stays tucked away

  await page.getByRole('button', { name: 'Run', exact: true }).click()

  const slips = page.getByRole('region', { name: 'Best Slips' })
  await expect(slips.getByRole('heading', { name: 'Power 2' })).toBeVisible()
  await expect(slips.getByText(/Caleb Williams/).first()).toBeVisible()

  const legs = page.getByRole('region', { name: 'Top Legs' })
  await expect(legs.getByRole('cell', { name: 'Caleb Williams' }).first()).toBeVisible()
  await expect(legs.getByRole('cell', { name: 'CHI vs NE' }).first()).toBeVisible()

  await expect(page.getByRole('region', { name: 'Unpriced' })).toBeVisible()
  await expect(page.getByText(/couldn't fetch the board/i)).toHaveCount(0)
  await expect(panel.getByText('Fetched just now')).toBeVisible()
})
