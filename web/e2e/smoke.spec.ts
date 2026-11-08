import { expect, test } from '@playwright/test'

test('container serves the shell and the engine answers', async ({ page, request }) => {
  const health = await request.get('/api/health')
  expect(await health.json()).toEqual({ status: 'ok' })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'PrizePicks EV Optimizer' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /^Engine/ })).toHaveText('Engine online')
})

test('client routes fall back to the shell', async ({ page }) => {
  await page.goto('/some/client/route')
  await expect(page.getByRole('heading', { name: 'PrizePicks EV Optimizer' })).toBeVisible()
})
