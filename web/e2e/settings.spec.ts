import { expect, run, test } from './test.ts'

test('settings change the run, filters work without re-running, settings are remembered', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'NHL' }).click()
  await page.getByRole('button', { name: 'MLB' }).click()
  await page.getByLabel('Stake').fill('20')
  await page.getByText('Advanced').click()
  await page.getByLabel('Edge against').selectOption('flex6')

  const runs: string[] = []
  page.on('request', (r) => r.url().endsWith('/api/run') && runs.push(r.postData() ?? ''))
  await run(page)

  await expect(page.getByText('$20 stake · cash · devig worst · NFL, NBA · next 24 h')).toBeVisible()
  await expect(page.getByText(/against the flex 6 break-even/)).toBeVisible()

  const slips = page.getByRole('region', { name: 'Best Slips' })
  await slips.getByRole('button', { name: 'Flex' }).click()
  await expect(slips.getByRole('heading', { name: 'Flex 2' })).toBeVisible()
  await expect(slips.getByRole('heading', { name: 'Power 2' })).toHaveCount(0)
  expect(runs).toHaveLength(1)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download JSON' }).click()
  expect((await download).suggestedFilename()).toMatch(/^ppopt-report-.*\.json$/)

  await page.reload()
  await expect(page.getByRole('button', { name: 'NHL' })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByLabel('Stake')).toHaveValue('20')
})
