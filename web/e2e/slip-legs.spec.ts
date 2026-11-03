import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const FIXTURE = new URL('../../tests/fixtures/pp_projections.json', import.meta.url)

function freshBoard(): Buffer {
  const board = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const start = new Date(Date.now() + 2 * 3600_000).toISOString()
  for (const p of board.data) p.attributes.start_time = p.attributes.end_time = start
  return Buffer.from(JSON.stringify(board))
}

async function slipLegs(page: import('@playwright/test').Page, width: number) {
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
      const rects = parts.map((p) => p.getBoundingClientRect())
      const card = li.closest('.slip')!.getBoundingClientRect()
      const line = parseFloat(getComputedStyle(li).lineHeight) || 21
      const overlap = (rs: DOMRect[]) => Math.max(...rs.map((r) => r.top)) < Math.min(...rs.map((r) => r.bottom))
      return {
        text: li.textContent!,
        parts: parts.length,
        visible: parts.every((p) => getComputedStyle(p).display !== 'none'),
        // Never wraps mid-phrase: every part is a single line.
        tallest: Math.max(...rects.map((r) => r.height)) / line,
        // The first four parts (odds, sport, matchup, player) always share a line.
        headOneLine: overlap(rects.slice(0, 4)),
        // The line (pick) is on the same line, or on the next line starting under the sport.
        pickOnSameLine: overlap(rects),
        pickOnSecondLine: rects[4].top >= rects[3].bottom - 1 && Math.abs(rects[4].left - rects[1].left) < 2,
        // Nothing is cut off by the card.
        inside: rects.every((r) => r.left >= card.left && r.right <= card.right),
      }
    }),
  )
  expect(legs.length).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  return legs
}

for (const width of [1440, 768]) {
  test(`every best-slip leg sits on one line at ${width}px`, async ({ page }) => {
    for (const leg of await slipLegs(page, width)) {
      expect(leg.parts, leg.text).toBe(5) // odds, sport, matchup, player, line
      expect(leg.visible, leg.text).toBe(true)
      expect(leg.tallest, leg.text).toBeLessThan(1.5)
      expect(leg.pickOnSameLine, leg.text).toBe(true)
      expect(leg.inside, leg.text).toBe(true)
    }
  })
}

test('on a phone each leg takes two lines: odds to player, then the line beneath', async ({ page }) => {
  for (const leg of await slipLegs(page, 375)) {
    expect(leg.parts, leg.text).toBe(5)
    expect(leg.visible, leg.text).toBe(true)
    expect(leg.tallest, leg.text).toBeLessThan(1.5)
    expect(leg.headOneLine, leg.text).toBe(true)
    expect(leg.pickOnSecondLine, leg.text).toBe(true)
    expect(leg.inside, leg.text).toBe(true)
  }
})
