import { defineConfig, devices } from '@playwright/test'

// Runs against the real container (`make up`). Override with PPOPT_URL to point elsewhere.
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: process.env.PPOPT_URL ?? 'http://localhost:8000' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
