import { defineConfig, devices } from '@playwright/test'

const chrome = { ...devices['Desktop Chrome'] }

// Runs against the real container (`make up`). Override with PPOPT_URL to point elsewhere.
// Under `make e2e` the partner feed is a file every spec shares (e2e/board.ts), so the specs that need it down run
// first, on their own, and the feed is put back before the rest run.
// The server runs one run at a time and keeps one set of run settings and one auto-runs switch for everyone, so
// specs run one at a time (workers: 1): two specs pressing Run together would have one refused. Each test puts the
// settings and the switch back as it found them (e2e/test.ts).
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: process.env.PPOPT_URL ?? 'http://localhost:8000' },
  projects: [
    { name: 'feed-down', testMatch: /board-fallback\.spec\.ts/, workers: 1, use: chrome },
    { name: 'feed-up', testMatch: /partner-feed\.setup\.ts/, dependencies: ['feed-down'] },
    { name: 'chromium', testIgnore: /board-fallback\.spec\.ts/, dependencies: ['feed-up'], workers: 1, use: chrome },
  ],
})
