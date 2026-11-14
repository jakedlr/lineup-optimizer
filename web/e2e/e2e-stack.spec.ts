import { test, expect } from '@playwright/test'
import config from '../playwright.config.ts'
import { refuseLiveApp } from './test.ts'

// Every spec resets auto runs and the run settings when it ends (e2e/test.ts). Pointed at the real app on :8000, that
// would wipe the user's own; the suite belongs on the e2e stack (`make e2e`, :8001).

test('specs go to the e2e stack unless told otherwise', () => {
  expect(process.env.PPOPT_URL ?? config.use?.baseURL).not.toMatch(/:8000\b/)
  if (!process.env.PPOPT_URL) expect(config.use?.baseURL).toBe('http://localhost:8001')
})

test("the reset after each test refuses to touch the app on :8000", () => {
  for (const url of ['http://localhost:8000', 'http://127.0.0.1:8000/', 'http://my-box:8000/x'])
    expect(() => refuseLiveApp(url)).toThrow(/8000/)
  expect(() => refuseLiveApp('http://localhost:8001')).not.toThrow()
})
