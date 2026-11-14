import { boardFile, removeFeed } from './board.ts'
import { expect, run, test } from './test.ts'

// The partner feed is down for this whole file. Its project runs before any other spec and before the feed is put
// back (playwright.config.ts), so nothing else sees the feed missing.
test.describe.configure({ mode: 'serial' })
test.beforeAll(() => removeFeed())

const FAILED = /couldn't fetch the board from PrizePicks' partner feed/i

test('with no feed and no board, the page says why and opens the upload fallback', async ({ page, request }) => {
  test.skip((await request.get('/api/board')).ok(), 'needs a container with no board yet, as `make e2e` starts')
  await page.goto('/')
  const panel = page.getByRole('region', { name: 'Board' })
  await expect(panel.getByText(FAILED)).toBeVisible()
  await expect(panel.getByText(FAILED)).toContainText('/feed/projections.json')
  await expect(panel.getByText('No board yet.')).toBeVisible()
  await expect(panel.locator('details')).toHaveAttribute('open', '')
  await expect(panel.getByRole('button', { name: 'Choose file' })).toBeVisible()

  await run(page)
  await expect(page.getByRole('alert')).toContainText(/no saved board to fall back on: upload one/)
})

test('with no feed, a run uses the uploaded board and says why', async ({ page }) => {
  await page.goto('/')
  const panel = page.getByRole('region', { name: 'Board' })
  await page.getByLabel('Choose board file').setInputFiles(boardFile())
  await expect(panel.getByText('Uploaded just now')).toBeVisible()
  await expect(panel.getByText('11 lines')).toBeVisible()
  await expect(panel.locator('details')).not.toHaveAttribute('open')

  // The upload persisted to the volume: a reload still shows it.
  await page.reload()
  await expect(panel.getByText(/Uploaded (just now|1 min ago)/)).toBeVisible()

  await run(page)
  await expect(page.getByRole('region', { name: 'Best Slips' }).getByRole('heading', { name: 'Power 2' })).toBeVisible()
  const warnings = page.locator('.warnings li')
  await expect(warnings.first()).toContainText(FAILED)
  await expect(warnings.first()).toContainText(/this run used the saved board, uploaded (just now|1 min ago)/)
  await expect(panel.getByText(/Uploaded (just now|1 min ago)/)).toBeVisible()
})

test('with no feed, an auto run does not fall back: it switches auto runs off and the page says why', async ({ page, request }) => {
  await page.goto('/')
  const toggle = page.getByRole('switch', { name: 'Auto runs' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  expect(await (await request.post('/api/auto/run-now')).json()).toEqual({ started: true })
  // The page sees it within one look at the server.
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 })
  const reason = page.locator('.auto-note')
  await expect(reason).toContainText(/the board couldn't be fetched from PrizePicks' partner feed/)
  await expect(reason).toContainText('/feed/projections.json')
  await expect(reason).toContainText(/so auto runs were switched off/)
  await expect(page.getByRole('alert')).toContainText(/so auto runs were switched off/) // the run's failure, marked
  await expect(page.getByRole('alert')).toContainText(/^Auto run · \d\d:\d\d/)
  await expect(page.getByRole('status', { name: 'Run notifications' }).getByText('Run failed')).toBeVisible()

  // Switching them back on clears the reason.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(reason).toHaveCount(0)
})
