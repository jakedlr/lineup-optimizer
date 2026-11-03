import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const FIXTURE = new URL('../../tests/fixtures/pp_projections.json', import.meta.url)

function freshBoard(): Buffer {
  const board = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const start = new Date(Date.now() + 2 * 3600_000).toISOString()
  for (const p of board.data) p.attributes.start_time = p.attributes.end_time = start
  return Buffer.from(JSON.stringify(board))
}

for (const width of [1440, 768, 375]) {
  test(`every best-slip leg sits on one line at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.getByLabel('Choose board file').setInputFiles({
      name: 'projections.json', mimeType: 'application/json', buffer: freshBoard(),
    })
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const slips = page.getByRole('region', { name: 'Best Slips' })
    await expect(slips.getByRole('article').first()).toBeVisible()

    const legs = await slips.locator('.slip-leg').evaluateAll((items) =>
      items.map((li) => {
        const parts = [...li.children] as HTMLElement[]
        const line = parseFloat(getComputedStyle(li).lineHeight) || 21
        return {
          text: li.textContent,
          parts: parts.length,
          // On one line: every part overlaps every other vertically (baselines differ by a few px across sizes).
          oneLine:
            Math.max(...parts.map((p) => p.getBoundingClientRect().top)) <
            Math.min(...parts.map((p) => p.getBoundingClientRect().bottom)),
          tallest: Math.max(...parts.map((p) => p.getBoundingClientRect().height)) / line,
          visible: parts.every((p) => getComputedStyle(p).display !== 'none'),
        }
      }),
    )
    expect(legs.length).toBeGreaterThan(0)
    for (const leg of legs) {
      expect(leg.parts, leg.text!).toBe(5) // odds, sport, matchup, player, line
      expect(leg.visible, leg.text!).toBe(true)
      expect(leg.oneLine, leg.text!).toBe(true)
      expect(leg.tallest, leg.text!).toBeLessThan(1.5)
    }

    // The page itself never scrolls sideways; a narrow slip scrolls inside its card.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
