import type { APIRequestContext, Page } from '@playwright/test'
import { boardFile, removeFeed, writeFeed } from './board.ts'
import { expect, hhmm, test } from './test.ts'

// Alerts (GLOSSARY: Alert, Alert tier, Qualifying leg) go to a stand-in ntfy server (web/e2e/fake-ntfy.py), which the
// app reaches as http://ntfy and these specs as NTFY, and which lists what it was sent at /_published.
// The fixture board's best legs: CHI vs NE's taco leg at +14.9%, CLE vs PHI's at −1.1% (two games, so at most two
// qualifying legs): high at +1.0% on 1 leg is met by the taco leg alone.

const NTFY = process.env.PPOPT_NTFY_URL ?? 'http://localhost:8002'
const IN_APP = 'http://ntfy'
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone // the browser's too, so the page leaves it be

interface Published {
  method: string
  topic: string
  title: string
  priority: string
  authorization: string | null
  body: string
}

const published = async (request: APIRequestContext): Promise<Published[]> => (await request.get(`${NTFY}/_published`)).json()

const topicFor = (name: string) => `pp-e2e-${name}-${Date.now().toString(36)}`

/** Alerts to the stand-in on `topic`, loud when one game's best leg reaches +1.0%. */
async function alertsTo(request: APIRequestContext, topic: string, server = IN_APP) {
  const answer = await request.patch('/api/alerts', {
    data: { server, topic, timezone: ZONE, high: { enabled: true, edge: 1.0, legs: 1 } },
  })
  expect(answer.ok()).toBe(true)
}

/** Start an auto run now and wait until its alert has gone (or failed to): the latest run, with its alert. */
async function autoRunAlerted(request: APIRequestContext) {
  const before = (await (await request.get('/api/status')).json()).latest?.id ?? null
  expect((await request.put('/api/auto', { data: { enabled: true } })).ok()).toBe(true)
  expect(await (await request.post('/api/auto/run-now')).json()).toEqual({ started: true })
  let latest: { id: string; started_at: string; alert: { sent: boolean; priority: number; title: string; error: string | null } | null } | null = null
  await expect
    .poll(
      async () => {
        latest = (await (await request.get('/api/status')).json()).latest
        return latest && latest.id !== before && latest.alert !== null
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  return latest!
}

const panel = (page: Page) => page.getByRole('region', { name: 'Phone alerts' })

test.beforeEach(async ({ request }) => {
  expect((await request.delete(`${NTFY}/_published`)).ok()).toBe(true)
})

test('an auto run meeting high alerts at priority 4 with its legs; the same legs again go at priority 1', async ({ page, request }) => {
  const topic = topicFor('high')
  await alertsTo(request, topic)
  await page.goto('/')

  const first = await autoRunAlerted(request)
  const at = hhmm(new Date(first.started_at))
  const [alert] = await published(request)
  expect(alert).toMatchObject({ method: 'POST', topic, priority: '4', title: `HIGH · 1 leg ≥ +1.0% · ${at}` })
  expect(alert.body.split('\n')[0]).toMatch(/^1\. .+ · NFL CHI vs NE · \+14\.9% \(\d+\.\d%\) · taco$/)
  expect(first.alert).toMatchObject({ sent: true, priority: 4, title: alert.title })

  // The page shows the run, then how its alert went, at a later look.
  await expect(page.getByText(`Auto run · ${at}`)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Alert sent · priority 4')).toBeVisible({ timeout: 10_000 })

  const second = await autoRunAlerted(request)
  const again = (await published(request))[1]
  expect(again).toMatchObject({ topic, priority: '1', title: `HIGH, unchanged · 1 leg ≥ +1.0% · ${hhmm(new Date(second.started_at))}` })
  await expect(page.getByText('Alert sent · priority 1')).toBeVisible({ timeout: 10_000 })
})

test('a failed board fetch alerts at priority 4: auto runs are off', async ({ page, request }) => {
  const topic = topicFor('off')
  await alertsTo(request, topic)
  // An uploaded board is never reused, so the auto run fetches one, from a feed that isn't there.
  expect((await request.put('/api/board', { multipart: { file: boardFile() } })).ok()).toBe(true)
  removeFeed()
  try {
    await page.goto('/')
    const latest = await autoRunAlerted(request)
    const [alert] = await published(request)
    expect(alert).toMatchObject({ topic, priority: '4', title: `AUTO RUNS OFF · board fetch failed · ${hhmm(new Date(latest.started_at))}` })
    expect(alert.body).toMatch(/couldn't be fetched from PrizePicks' partner feed/)
    await expect(page.getByRole('alert')).toContainText(/so auto runs were switched off/, { timeout: 10_000 })
    await expect(page.getByText('Alert sent · priority 4')).toBeVisible({ timeout: 10_000 })
  } finally {
    writeFeed()
  }
})

test('an alert ntfy never got is shown as not delivered, and auto runs go on', async ({ page, request }) => {
  await alertsTo(request, topicFor('down'), 'http://127.0.0.1:9') // nothing listens there
  await page.goto('/')
  const latest = await autoRunAlerted(request)
  expect(latest.alert).toMatchObject({ sent: false, priority: 4 })
  await expect(page.getByText(/^Alert not delivered: couldn't reach http:\/\/127\.0\.0\.1:9/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('switch', { name: 'Auto runs' })).toHaveAttribute('aria-checked', 'true')
  expect(await published(request)).toEqual([])
})

test('the panel picks a topic, checks it, and sends a test alert through the stand-in', async ({ page, request }) => {
  await page.goto('/')
  const alerts = panel(page)
  await expect(alerts.locator('details').first()).toHaveAttribute('open', '') // no topic yet: open
  await alerts.getByText('Server and token').click()
  await alerts.getByLabel('Server').fill(IN_APP)
  await alerts.getByRole('button', { name: 'Random' }).click()
  const topic = await alerts.getByLabel('Topic').inputValue()
  expect(topic).toMatch(/^pp-[a-z0-9]{12}$/)
  await expect.poll(async () => (await (await request.get('/api/alerts')).json()).topic).toBe(topic)
  expect((await (await request.get('/api/alerts')).json()).server).toBe(IN_APP)

  await alerts.getByRole('button', { name: 'Check' }).click()
  await expect(alerts.getByText('Looks unused: no recent messages on this topic')).toBeVisible()

  await alerts.getByRole('button', { name: 'Send test' }).click()
  await expect(alerts.getByText(`Test alert sent to ${topic}`)).toBeVisible()
  expect(await published(request)).toMatchObject([{ topic, priority: '3', title: 'Test alert · PrizePicks EV Optimizer' }])

  await alerts.getByRole('button', { name: 'Check' }).click()
  await expect(alerts.getByText('In use: 1 message posted to this topic recently: someone else may be using it')).toBeVisible()

  await alerts.getByLabel('Topic').fill('reserved-topic')
  await alerts.getByRole('button', { name: 'Check' }).click()
  await expect(alerts.getByText('Reserved: someone has reserved this topic: only they can read it')).toBeVisible()
  await alerts.getByRole('button', { name: 'Send test' }).click()
  await expect(alerts.getByText(/^Test alert not sent: ntfy refused it \(403: forbidden\)$/)).toBeVisible()

  // Opened again with a topic set, the panel is folded away, naming it.
  await page.reload()
  await expect(alerts.getByText('reserved-topic on ntfy')).toBeVisible()
  await expect(alerts.locator('details').first()).not.toHaveAttribute('open')
})

test('the tiers save as they are changed, and warn when medium is set above high', async ({ page, request }) => {
  await page.goto('/')
  const alerts = panel(page)
  const high = alerts.getByRole('group', { name: 'High tier' })
  const medium = alerts.getByRole('group', { name: 'Medium tier' })
  await expect(high.getByText('3 or more games with a leg ≥ +1.0%')).toBeVisible()
  await medium.getByLabel('Edge').fill('2.5')
  await expect(alerts.getByText(/medium's edge bar is above high's/i)).toBeVisible()
  await high.getByLabel('Qualifying legs').fill('2')
  await medium.getByRole('switch').click()
  await expect(alerts.getByText(/medium's edge bar is above high's/i)).toHaveCount(0)
  await expect
    .poll(async () => (await (await request.get('/api/alerts')).json()))
    .toMatchObject({ high: { enabled: true, edge: 1, legs: 2 }, medium: { enabled: false, edge: 2.5, legs: 3 } })
})

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`the alerts panel fits a ${viewport.width}px screen, each tier's controls on its row`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    const alerts = panel(page)
    await alerts.getByText('Server and token').click()
    await alerts.getByLabel('Topic').fill('a-rather-long-topic-name-that-someone-typed-in-by-hand-0123456789')
    await expect(alerts.getByRole('link', { name: /^ntfy\.sh\// })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    const box = (await alerts.boundingBox())!
    for (const el of await alerts.locator('input, button, a, p').all()) {
      if (!(await el.isVisible())) continue
      const b = (await el.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(box.x)
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5)
    }

    for (const name of ['High tier', 'Medium tier']) {
      const tier = alerts.getByRole('group', { name })
      const toggle = (await tier.getByRole('switch').boundingBox())!
      const edge = (await tier.getByLabel('Edge').boundingBox())!
      const legs = (await tier.getByLabel('Qualifying legs').boundingBox())!
      expect(toggle.height).toBeGreaterThanOrEqual(32) // a comfortable target
      expect(Math.abs(edge.y - legs.y)).toBeLessThan(2) // edge and legs side by side
      if (viewport.width > 640) expect(Math.abs(toggle.y + toggle.height / 2 - (edge.y + edge.height / 2))).toBeLessThan(4)
      else expect(toggle.y + toggle.height).toBeLessThanOrEqual(edge.y) // the switch heads the row on a phone
    }
  })
}
