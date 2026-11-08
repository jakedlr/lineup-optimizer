import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

// Runs against the e2e container (`make e2e`), whose canned odds count as live requests: every run is fresh.
const FIXTURE = new URL('../../tests/fixtures/pp_projections.json', import.meta.url)

function freshBoard(): Buffer {
  const board = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const start = new Date(Date.now() + 2 * 3600_000).toISOString()
  for (const p of board.data) p.attributes.start_time = p.attributes.end_time = start
  return Buffer.from(JSON.stringify(board))
}

async function uploadAndRun(page: Page) {
  await page.goto('/')
  await page.getByLabel('Choose board file').setInputFiles({
    name: 'projections.json', mimeType: 'application/json', buffer: freshBoard(),
  })
  await expect(page.getByText('Board saved just now')).toBeVisible()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
}

const toastIn = (page: Page) => page.getByRole('status', { name: 'Run notifications' })

for (const viewport of [{ width: 375, height: 800 }, { width: 1440, height: 900 }]) {
  test.describe(`at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('a finished run pops up in view, clear of the Run button', async ({ page }) => {
      await uploadAndRun(page)
      const region = toastIn(page)
      await expect(region.getByText('Run finished')).toBeVisible()
      await expect(region).toContainText(/\d+ slips? · best [+−]\d+\.\d% EV \((Power|Flex) \d\)|No slips/)

      const toast = (await region.locator('.toast').boundingBox())!
      expect(toast.x).toBeGreaterThanOrEqual(0)
      expect(toast.y).toBeGreaterThanOrEqual(0)
      expect(toast.x + toast.width).toBeLessThanOrEqual(viewport.width)
      expect(toast.y + toast.height).toBeLessThanOrEqual(viewport.height)

      const run = (await page.getByRole('button', { name: 'Run', exact: true }).boundingBox())!
      const overlaps =
        toast.x < run.x + run.width && run.x < toast.x + toast.width &&
        toast.y < run.y + run.height && run.y < toast.y + toast.height
      expect(overlaps).toBe(false)

      await region.getByRole('button', { name: 'Dismiss notification' }).click()
      await expect(region.getByText('Run finished')).toHaveCount(0)
    })
  })
}

test('a run that ends in a hidden tab marks the title', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  })
  await uploadAndRun(page)
  await expect(toastIn(page).getByText('Run finished')).toBeVisible()
  await expect(page).toHaveTitle('✓ PrizePicks EV Optimizer') // taste-skill-ignore: the tab title prefix under test
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon-dot.svg')
})

test('with the toggle on, a run that ends in a hidden tab sends one system notification', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    const made: { title: string; body?: string; tag?: string }[] = []
    class FakeNotification {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      onclick: (() => void) | null = null
      constructor(title: string, options?: NotificationOptions) {
        made.push({ title, body: options?.body, tag: options?.tag })
      }
      close() {}
    }
    Object.assign(window, { Notification: FakeNotification, __notifications: made })
  })
  await page.goto('/')
  await page.getByText('Advanced').click()
  const toggle = page.getByLabel('Notify me when runs finish')
  await expect(toggle).toBeEnabled()
  await toggle.check()
  await uploadAndRun(page)
  await expect(toastIn(page).getByText('Run finished')).toBeVisible()

  const made = await page.evaluate(() => (window as unknown as { __notifications: unknown[] }).__notifications)
  expect(made).toEqual([{ title: 'Run finished', body: expect.stringMatching(/slip|No slips/), tag: 'ppopt-run' }])
})
