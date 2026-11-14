import type { Page } from '@playwright/test'
import { boardFile, holdFeed } from './board.ts'
import { expect, hhmm, test } from './test.ts'

// Auto runs (GLOSSARY: Auto run). `POST /api/auto/run-now` (PPOPT_E2E=1) starts one as a quarter mark would.

const autoSwitch = (page: Page) => page.getByRole('switch', { name: 'Auto runs' })

/** The quarter marks a page might name as the next run, looking now: the next, or the one after at a boundary. */
function nextMarks() {
  const q = 15 * 60_000
  const next = Math.floor(Date.now() / q) * q + q
  return [hhmm(new Date(next)), hhmm(new Date(next + q))]
}

test('switching auto runs on names the next quarter mark; off again, it goes', async ({ page }) => {
  await page.goto('/')
  await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'false')
  const marks = nextMarks()
  await autoSwitch(page).click()
  await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'true')
  const next = page.getByText(/^Next run \d\d:(00|15|30|45)$/)
  await expect(next).toBeVisible()
  expect(marks).toContain((await next.textContent())!.replace('Next run ', ''))

  await page.reload() // remembered by the server
  await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'true')

  await autoSwitch(page).press('Space')
  await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByText(/^Next run/)).toHaveCount(0)
})

test('an auto run is watched to its report, with Run held meanwhile and the run notification at the end', async ({ page, request }) => {
  // An uploaded board is never reused, so the auto run fetches one, from a feed that answers when this spec says.
  expect((await request.put('/api/board', { multipart: { file: boardFile() } })).ok()).toBe(true)
  await page.goto('/')
  await autoSwitch(page).click()
  await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'true')

  const release = holdFeed()
  try {
    expect(await (await request.post('/api/auto/run-now')).json()).toEqual({ started: true })
    const { running } = await (await request.get('/api/status')).json()
    expect(running).toMatchObject({ started_by: 'auto' })

    const run = page.getByRole('button', { name: 'Run', exact: true })
    // The page looks at the server every 5 s.
    await expect(page.getByText(`Auto run going (started ${hhmm(new Date(running.started_at))})…`)).toBeVisible({ timeout: 10_000 })
    await expect(run).toBeDisabled()
    await expect(page.getByRole('progressbar', { name: 'Run progress' })).toBeVisible()
    await expect(page.getByText('Fetching the PrizePicks board')).toBeVisible()
    await release()

    await expect(page.getByText(`Auto run · ${hhmm(new Date(running.started_at))}`)).toBeVisible()
    await expect(page.getByRole('region', { name: 'Best Slips' }).getByRole('heading', { name: 'Power 2' })).toBeVisible()
    await expect(page.getByRole('status', { name: 'Run notifications' }).getByText('Run finished')).toBeVisible()
    await expect(run).toBeEnabled()
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Board' }).getByText('Fetched just now')).toBeVisible()
  } finally {
    await release()
  }

  // Opened afresh, the page shows the same report, marked the same way.
  await page.reload()
  const { latest } = await (await request.get('/api/status')).json()
  await expect(page.getByText(`Auto run · ${hhmm(new Date(latest.started_at))}`)).toBeVisible()
})

test('run settings changed on the page come back from the server, not from this browser', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'NBA', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'MLB', exact: true }).click()
  await page.getByLabel('Stake').fill('15')
  await page.getByText('Advanced').click()
  await page.getByLabel('Devig method').selectOption('shin')
  await expect
    .poll(async () => (await request.get('/api/settings')).json())
    .toEqual({ sports: ['NFL', 'NBA', 'NHL'], stake: 15, hours: 24, devig: 'shin', ref_slip: null, saved: true })

  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('button', { name: 'MLB', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByLabel('Stake')).toHaveValue('15')
  await page.getByText('Advanced').click()
  await expect(page.getByLabel('Devig method')).toHaveValue('shin')
})

for (const viewport of [{ width: 375, height: 800 }, { width: 1440, height: 900 }]) {
  test(`the auto runs switch shows which way it is set, by Run, at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    const toggle = autoSwitch(page)
    await expect(toggle).toBeEnabled()
    const thumb = toggle.locator('.switch-thumb')
    const track = toggle.locator('.switch-track')
    const offAt = (await thumb.boundingBox())!
    const box = (await track.boundingBox())!
    expect(box.width).toBeGreaterThan(offAt.width * 1.5) // a track the thumb slides along
    expect(offAt.x - box.x).toBeLessThan(box.width / 2 - offAt.width / 2) // off: thumb at the start

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText(/^Next run/)).toBeVisible()
    expect((await track.boundingBox())!.x).toBe(box.x) // the switch holds still as "Next run" appears beside it
    await expect.poll(async () => (await thumb.boundingBox())!.x - box.x).toBeGreaterThan(box.width / 2 - offAt.width / 2)
    const colour = () => track.evaluate((t) => getComputedStyle(t).backgroundColor)
    const onColour = await colour()

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(colour).not.toBe(onColour) // on and off look different, not just positioned

    // A comfortable target, beside Run on a wide screen, and the page still fits a phone.
    const target = (await toggle.boundingBox())!
    expect(target.height).toBeGreaterThanOrEqual(32)
    if (viewport.width > 640) {
      const run = (await page.getByRole('button', { name: 'Run', exact: true }).boundingBox())!
      expect(Math.abs(target.y + target.height / 2 - (run.y + run.height / 2))).toBeLessThan(4)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
