import type { Locator, Page } from '@playwright/test'
import { holdFeed } from './board.ts'
import { expect, run, test } from './test.ts'

// Sprint 11, M2–M3 and MO-6, and Sprint 12: the setup cards come first, then Run, then the report; on a phone Run is
// held in a bar at the foot of the screen wherever the page is scrolled; the theme is chosen at the foot of the page.

const runButton = (page: Page) => page.getByRole('button', { name: /^Run/ })
const slipsHeading = (page: Page) => page.getByRole('heading', { name: 'Best Slips' })
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

/** The page open on a report from a real run. */
async function withReport(page: Page) {
  await page.goto('/')
  await expect(runButton(page)).toBeEnabled()
  await run(page)
  await expect(slipsHeading(page)).toBeVisible()
}

/** Whether `el` is inside the viewport and is what a tap at its centre lands on (nothing drawn over it). */
async function onScreen(page: Page, el: Locator) {
  const box = (await el.boundingBox())!
  const { height } = page.viewportSize()!
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? null, [
    box.x + box.width / 2,
    box.y + box.height / 2,
  ])
  return box.y >= 0 && box.y + box.height <= height && hit === (await el.textContent())
}

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the setup cards, then Run, then the report, with Run and the top of Best Slips on the first screen', async ({ page }) => {
    await withReport(page)
    expect(await page.evaluate(() => scrollY)).toBe(0)
    const run = (await runButton(page).boundingBox())!
    expect(run.y + run.height).toBeLessThan(900)
    const slips = (await slipsHeading(page).boundingBox())!
    expect(slips.y + slips.height).toBeLessThan(900)
    const top = async (name: string) => (await page.getByRole('region', { name, exact: true }).boundingBox())!.y
    const settings = await top('Run settings')
    const promos = await top('Promos')
    const alerts = await top('Phone alerts')
    expect(promos).toBeGreaterThan(settings)
    expect(alerts).toBeGreaterThan(promos)
    expect(run.y).toBeGreaterThan(alerts)
    expect(slips.y).toBeGreaterThan(run.y)
    expect(await top('Top Legs')).toBeGreaterThan(slips.y)
    // Fresh odds sits in the Run row; the theme at the foot of the page, after the report.
    const fresh = (await page.getByLabel(/Fresh odds/).boundingBox())!
    expect(Math.abs(fresh.y + fresh.height / 2 - (run.y + run.height / 2))).toBeLessThan(6)
    const theme = (await page.getByRole('group', { name: 'Theme' }).boundingBox())!
    expect(theme.y).toBeGreaterThan(await top('Top Legs'))
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('Run stays on screen in a bar at the foot, from the top of the page to Top Legs, and covers nothing', async ({ page }) => {
    await withReport(page)
    await page.evaluate(() => scrollTo(0, 0))
    const button = runButton(page)
    expect(await onScreen(page, button)).toBe(true)
    const bar = (await page.locator('.run-bar').boundingBox())!
    expect(bar.y + bar.height).toBeCloseTo(844, 0) // at the foot of the screen
    expect(bar.x).toBe(0)
    expect(bar.width).toBe(390)
    // The bar holds Run and the auto runs switch; the next run and Fresh odds stay in the page.
    await expect(page.locator('.run-bar').getByRole('switch', { name: 'Auto runs' })).toBeVisible()
    await expect(page.locator('.run-bar').getByLabel(/Fresh odds/)).toHaveCount(0)

    await page.getByRole('heading', { name: 'Top Legs' }).evaluate((h) => h.scrollIntoView({ block: 'start' }))
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(300)
    expect(await onScreen(page, button)).toBe(true)
    expect(await fits(page)).toBe(true)

    // At the very end the bar rests under the theme, which it doesn't cover.
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
    const theme = (await page.getByRole('group', { name: 'Theme' }).boundingBox())!
    const rest = (await page.locator('.run-bar').boundingBox())!
    expect(theme.y + theme.height).toBeLessThanOrEqual(rest.y)
    expect(await onScreen(page, page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }))).toBe(true)
  })

  test("a run pressed from deep in the report brings its progress into view, and its pop-up clears the bar", async ({ page }) => {
    await withReport(page)
    await page.getByLabel(/Fresh odds/).check() // a fresh run, so it raises a pop-up
    await page.getByRole('heading', { name: 'Top Legs' }).evaluate((h) => h.scrollIntoView({ block: 'start' }))
    const release = holdFeed()
    try {
      await runButton(page).click()
      const progress = page.locator('.run-progress')
      await expect(progress).toBeVisible()
      await expect.poll(async () => {
        const box = (await progress.boundingBox())!
        return box.y >= 0 && box.y + box.height <= 844
      }).toBe(true)
    } finally {
      await release()
    }
    const toast = page.locator('.toast')
    await expect(toast).toBeVisible({ timeout: 30_000 })
    const t = (await toast.boundingBox())!
    const bar = (await page.locator('.run-bar').boundingBox())!
    expect(t.y + t.height).toBeLessThan(bar.y)
  })
})
