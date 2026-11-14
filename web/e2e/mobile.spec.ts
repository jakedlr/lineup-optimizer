import { expect, run, test } from './test.ts'

test.use({ viewport: { width: 375, height: 800 } })

test('the report fits a phone without sideways scrolling', async ({ page }) => {
  await page.goto('/')
  await run(page)
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
