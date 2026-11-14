import type { Page, Route } from '@playwright/test'
import { expect, run, test } from './test.ts'

// How the report, a run failure and a run in progress lay out (Sprint 11, group R). One real run gives a report from
// the canned odds; the rest stand that report (or a failure) in for /api/run, so each case is shaped exactly and the
// server isn't asked to run again.

const LONG_URL = 'https://partner-api.prizepicks.com/projections?per_page=1000&single_stat=true&league_id=9&game_mode=pickem'
const LONG_NAME = 'Christopher Bartholomew Montgomery-Wolstenholme'

type Report = Record<string, any>

/** Run once for real and hand back the report it made. */
async function realReport(page: Page): Promise<Report> {
  await page.goto('/')
  await run(page)
  return (await (await page.request.get('/api/report/latest')).json()).report
}

/** The next Run answers with `report` (as a plain JSON answer, which the page takes as the run's report). */
async function answerWith(page: Page, report: Report) {
  await page.route('**/api/run', (route) => route.fulfill({ json: report }), { times: 1 })
  await run(page)
}

/** The next Run fails after the server names it, with `detail` as the reason. */
async function failWith(page: Page, detail: string) {
  const head = { type: 'run', id: 'e2e-failed', started_by: 'manual', started_at: new Date().toISOString() }
  const body = [head, { type: 'error', detail }].map((e) => JSON.stringify(e) + '\n').join('')
  await page.route('**/api/run', (route) => route.fulfill({ body, contentType: 'application/x-ndjson' }), { times: 1 })
  await run(page)
  await expect(page.getByRole('alert')).toBeVisible()
}

const pageFits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 800 } })

  test('a warning or a failure quoting a long URL wraps instead of widening the page', async ({ page }) => {
    const report = await realReport(page)
    await answerWith(page, { ...report, warnings: [`fanduel unavailable: couldn't reach ${LONG_URL}`] })
    await expect(page.locator('.warnings li')).toContainText(LONG_URL)
    expect(await pageFits(page)).toBe(true)

    await failWith(page, `no sportsbook odds available: couldn't reach ${LONG_URL}`)
    expect(await pageFits(page)).toBe(true)
  })

  test("a long player name in a slip wraps whole, never cut short", async ({ page }) => {
    const report = await realReport(page)
    const slips = report.slips.map((s: Report) => ({ ...s, legs: s.legs.map((l: Report, i: number) => (i ? l : { ...l, player: LONG_NAME })) }))
    await answerWith(page, { ...report, slips })
    const who = page.getByRole('region', { name: 'Best Slips' }).locator('.slip-leg .who', { hasText: LONG_NAME }).first()
    await expect(who).toBeVisible()
    const cut = await who.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === 'ellipsis')
    expect(cut).toBe(false)
    expect(await pageFits(page)).toBe(true)
  })

  test("a slip's heading wraps under a large EV rather than overflowing its card", async ({ page }) => {
    const report = await realReport(page)
    const slips = report.slips.map((s: Report) => ({ ...s, ev: 123456.78, ev_pct: 12.3456 }))
    await answerWith(page, { ...report, slips })
    const headers = page.getByRole('region', { name: 'Best Slips' }).locator('.slip header')
    await expect(headers.first()).toContainText('+$123,456.78')
    const spill = await headers.evaluateAll((hs) => hs.filter((h) => h.scrollWidth > h.clientWidth + 1).length)
    expect(spill).toBe(0)
    expect(await pageFits(page)).toBe(true)
  })

  test('each Top Legs card reads player and edge, pick and prob, then one grey meta line', async ({ page }) => {
    await realReport(page)
    const rows = page.getByRole('region', { name: 'Top Legs' }).locator('tbody tr:not(.below-row)')
    await expect(rows.first()).toBeVisible()
    const cards = await rows.evaluateAll((trs) =>
      trs.map((tr) => {
        const box = (sel: string) => tr.querySelector(sel)!.getBoundingClientRect()
        const shown = (sel: string) => getComputedStyle(tr.querySelector(sel)!).display !== 'none'
        const sameLine = (a: DOMRect, b: DOMRect) => a.top < b.bottom && b.top < a.bottom
        const [player, edge, pick, prob, meta] = ['.c-player', '.c-edge', '.c-pick', '.c-prob', '.c-meta'].map(box)
        return {
          text: tr.textContent,
          line1: sameLine(player, edge),
          line2: sameLine(pick, prob) && pick.top >= player.bottom - 1,
          line3: meta.top >= pick.bottom - 1 && meta.top >= prob.bottom - 1,
          metaSize: getComputedStyle(tr.querySelector('.c-meta')!).fontSize,
          metaText: tr.querySelector('.c-meta')!.textContent,
          columnsHidden: ['.c-sport', '.c-matchup', '.c-books', '.c-notes'].every((s) => !shown(s)),
          inside: [player, edge, pick, prob, meta].every((r) => r.right <= tr.getBoundingClientRect().right + 1),
        }
      }),
    )
    for (const c of cards) {
      expect(c.line1, c.text!).toBe(true)
      expect(c.line2, c.text!).toBe(true)
      expect(c.line3, c.text!).toBe(true)
      expect(c.metaSize).toBe('12px')
      expect(c.metaText).toMatch(/^[A-Z]+ · \S+ vs \S+ · /) // league · matchup · books…
      expect(c.columnsHidden, c.text!).toBe(true)
      expect(c.inside, c.text!).toBe(true)
    }
  })

  test('a run failure is an ink card with its mark on a line of its own and Try again', async ({ page }) => {
    await realReport(page)
    await failWith(page, 'no sportsbook odds available: draftkings unavailable')
    const alert = page.getByRole('alert')
    await expect(alert.getByText(/^Run · \d\d:\d\d failed$/)).toBeVisible()
    await expect(alert.getByText('No sportsbook odds available: draftkings unavailable')).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    const look = await alert.evaluate((el) => {
      const [mark, reason] = [...el.querySelectorAll('p')].map((p) => p.getBoundingClientRect())
      return {
        ink: getComputedStyle(el).color === getComputedStyle(document.documentElement).color,
        border: getComputedStyle(el).borderTopWidth,
        markAbove: mark.bottom <= reason.top + 1,
        dot: getComputedStyle(el.querySelector('p')!, '::before').width,
      }
    })
    expect(look).toEqual({ ink: true, border: '1px', markAbove: true, dot: '6px' })
  })
})

test.describe('on a tablet', () => {
  test.use({ viewport: { width: 900, height: 900 } })

  test('Top Legs drops the Sport and Matchup columns into a grey line under the player, and fits', async ({ page }) => {
    await realReport(page)
    const legs = page.getByRole('region', { name: 'Top Legs' })
    await expect(legs.getByRole('columnheader', { name: 'Sport' })).toBeHidden()
    await expect(legs.getByRole('columnheader', { name: 'Matchup' })).toBeHidden()
    const cell = legs.locator('tbody tr:not(.below-row) .c-player').first()
    const under = await cell.evaluate((td) => {
      const who = td.querySelector('.who')!.getBoundingClientRect()
      const sub = td.querySelector('.sub')!
      return { below: sub.getBoundingClientRect().top >= who.bottom - 1, size: getComputedStyle(sub).fontSize, text: sub.textContent }
    })
    expect(under).toMatchObject({ below: true, size: '12px' })
    expect(under.text).toMatch(/^[A-Z]+ · \S+ vs \S+$/)
    const spill = await legs.locator('.table-wrap').evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    expect(spill).toBe(false)
  })
})

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("each book's figures line up in their own column, a dash where a book has no price", async ({ page }) => {
    const report = await realReport(page)
    const [first, ...rest] = report.legs as Report[]
    // The columns are every book that priced any leg, in name order; this copy of the first leg keeps only its first.
    const books = [...new Set((report.legs as Report[]).flatMap((l) => Object.keys(l.books)))].sort()
    expect(books.length).toBeGreaterThan(1) // the canned odds price legs at more than one book
    const kept = Object.keys(first.books)[0]
    const missing = { ...first, line: first.line + 1, books: { [kept]: first.books[kept] } }
    await answerWith(page, { ...report, legs: [first, missing, ...rest] })
    const columns = await page
      .getByRole('region', { name: 'Top Legs' })
      .locator('tbody tr:not(.below-row) .c-books')
      .evaluateAll((cells) => cells.map((c) => [...c.querySelectorAll('.book')].map((b) => Math.round(b.getBoundingClientRect().right))))
    expect(new Set(columns.map((c) => c.join())).size).toBe(1) // every row's figures end on the same edges
    const figures = page.locator('tbody tr').nth(1).locator('.c-books .book')
    await expect(figures).toHaveText(books.map((b) => (b === kept ? /\d/ : '–')))
  })

  test('a negative edge is grey, and a divider row names the break-even the legs below it miss', async ({ page }) => {
    const report = await realReport(page)
    const below = report.legs.map((l: Report, i: number) => (i === report.legs.length - 1 ? { ...l, edge: -0.021 } : l))
    await answerWith(page, { ...report, legs: below })
    const legs = page.getByRole('region', { name: 'Top Legs' })
    await expect(legs.locator('.below-row')).toHaveText(/^Below the (Power|Flex) \d break-even, \d+\.\d% per leg$/)
    const colours = await legs.locator('.c-edge').evaluateAll((tds) =>
      tds.map((td) => ({ text: td.textContent, colour: getComputedStyle(td).color })),
    )
    const muted = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.className = 'muted'
      document.body.append(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    })
    expect(colours.find((c) => c.text === '−2.1%')?.colour).toBe(muted)
  })
})

test.describe('while a run is going', () => {
  test('the report shown dims to half, then the new one arrives at full strength', async ({ page }) => {
    const report = await realReport(page)
    let answer!: () => void
    const held = new Promise<void>((r) => (answer = r))
    await page.route('**/api/run', async (route: Route) => (await held, route.fulfill({ json: report })), { times: 1 })
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const opacity = () => page.locator('.report').evaluate((el) => getComputedStyle(el).opacity)
    await expect.poll(opacity).toBe('0.5')
    await expect(page.locator('.report-head .run-mark')).toHaveText(/^Previous run · \d\d:\d\d$/)
    answer()
    await expect(page.locator('.report-head .run-mark')).toHaveText(/^Run · \d\d:\d\d$/)
    await expect.poll(opacity).toBe('1')
  })

  test('the report the page opens on is simply there; a new result fades in', async ({ page }) => {
    await realReport(page) // so the page opens on a report
    // Read each report's opacity on the first frame after it is put on the page.
    await page.addInitScript(() => {
      const seen: string[] = ((window as any).__reportOpacity = [])
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes)
            if (n instanceof HTMLElement && n.classList.contains('report'))
              requestAnimationFrame(() => seen.push(getComputedStyle(n).opacity))
      }).observe(document, { childList: true, subtree: true })
    })
    await page.reload()
    await expect(page.locator('.report')).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as any).__reportOpacity.length)).toBe(1)
    expect(await page.evaluate(() => (window as any).__reportOpacity[0])).toBe('1')

    await run(page)
    await expect.poll(() => page.evaluate(() => (window as any).__reportOpacity.length)).toBe(2)
    expect(Number(await page.evaluate(() => (window as any).__reportOpacity[1]))).toBeLessThan(1)
  })
})

test('no "No report yet" card flashes while the page opens on a report', async ({ page }) => {
  await realReport(page)
  await page.addInitScript(() => {
    ;(window as any).__emptySeen = false
    new MutationObserver(() => {
      if (document.querySelector('.report-empty')) (window as any).__emptySeen = true
    }).observe(document, { childList: true, subtree: true })
  })
  await page.reload()
  await expect(page.locator('.report')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__emptySeen)).toBe(false)
})
