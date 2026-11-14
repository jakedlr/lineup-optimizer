import { expect, test } from '@playwright/test'
import { boardFile, removeFeed } from './board.ts'

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

  await page.getByRole('button', { name: 'Run', exact: true }).click()
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

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Best Slips' }).getByRole('heading', { name: 'Power 2' })).toBeVisible()
  const warnings = page.locator('.warnings li')
  await expect(warnings.first()).toContainText(FAILED)
  await expect(warnings.first()).toContainText(/this run used the saved board, uploaded (just now|1 min ago)/)
  await expect(panel.getByText(/Uploaded (just now|1 min ago)/)).toBeVisible()
})
