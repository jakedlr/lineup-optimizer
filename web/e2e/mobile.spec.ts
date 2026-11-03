import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const FIXTURE = new URL('../../tests/fixtures/pp_projections.json', import.meta.url)

test.use({ viewport: { width: 375, height: 800 } })

test('the report fits a phone without sideways scrolling', async ({ page }) => {
  const board = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const start = new Date(Date.now() + 2 * 3600_000).toISOString()
  for (const p of board.data) p.attributes.start_time = p.attributes.end_time = start

  await page.goto('/')
  await page.getByLabel('Choose board file').setInputFiles({
    name: 'projections.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(board)),
  })
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Top Legs' })).toBeVisible()
  await page.getByText('Show lines').click()

  const overflow = await page.evaluate(() => {
    const wide = (el: Element) => el.scrollWidth > el.clientWidth + 1
    return {
      page: document.documentElement.scrollWidth > window.innerWidth,
      tables: [...document.querySelectorAll('.table-wrap')].filter(wide).length,
    }
  })
  expect(overflow).toEqual({ page: false, tables: 0 })

  // Each leg still shows its essentials (the header row is hidden on phones).
  const first = page.getByRole('region', { name: 'Top Legs' }).getByRole('row').first()
  await expect(first).toContainText('Caleb Williams')
  await expect(first).toContainText('Over 215.5 Pass Yards')
  await expect(first).toContainText('69.1%')
})
