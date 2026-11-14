import { test as base, expect, type Page } from '@playwright/test'

/** The port of the real app (`make up`), whose auto runs and run settings are the user's own. */
const LIVE_APP_PORT = '8000'

/** Throws when `baseURL` is the real app: the suite resets server state, so it runs only on the e2e stack. */
export function refuseLiveApp(baseURL: string | undefined) {
  if (baseURL && new URL(baseURL).port === LIVE_APP_PORT)
    throw new Error(`refusing to run e2e against ${baseURL}: port ${LIVE_APP_PORT} is the real app; use \`make e2e\` (:8001)`)
}

/** The alert settings the server starts with (src/ppopt/alerts.py), bar the time zone: no topic, so no alerts. */
export const ALERT_DEFAULTS = {
  server: 'https://ntfy.sh',
  topic: '',
  token: '',
  medium: { enabled: true, edge: 0.5, legs: 3 },
  high: { enabled: true, edge: 1.0, legs: 3 },
}

// Run settings, alert settings, auto runs and the latest run live on the server (docs/adr/0003-server-side-auto-runs.md),
// shared by every spec. Each test leaves auto runs off (so a real quarter mark can't start a run mid-suite), the run
// settings at the engine's defaults, the alert settings at theirs (no topic) with what was last alerted forgotten, so
// the suite refuses to run against the real app. Only one run goes at a time, so the specs that start runs run one at
// a time (playwright.config.ts).
export const test = base.extend<{ serverState: void }>({
  serverState: [
    async ({ request, baseURL }, use) => {
      refuseLiveApp(baseURL)
      await use()
      expect((await request.put('/api/auto', { data: { enabled: false } })).ok()).toBe(true)
      const { defaults } = await (await request.get('/api/options')).json()
      expect((await request.put('/api/settings', { data: defaults })).ok()).toBe(true)
      // None chosen can't be put back: the zone goes back to this machine's, the one the page chose on first opening.
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      expect((await request.patch('/api/alerts', { data: { ...ALERT_DEFAULTS, timezone } })).ok()).toBe(true)
      expect((await request.post('/api/alerts/forget')).ok()).toBe(true)
    },
    { auto: true },
  ],
})

export { expect }

/**
 * Press Run and wait for the run to end. The page opens on the latest run's report, so a spec that looked straight
 * away could read the last spec's report instead of this one's.
 */
export async function run(page: Page) {
  const button = page.getByRole('button', { name: 'Run', exact: true })
  const ended = page.waitForResponse((r) => r.url().endsWith('/api/run') && r.request().method() === 'POST')
  await button.click()
  await (await ended).finished()
  await expect(button).toHaveText('Run')
}

/** A local "HH:MM", as the page shows a time. */
export const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
