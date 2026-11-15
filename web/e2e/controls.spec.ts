import type { Locator, Page } from '@playwright/test'
import { holdFeed } from './board.ts'
import { expect, test } from './test.ts'

// Sprint 11, group C: what CSS decides about the controls. Edges that read, disabled that stays legible, busy that
// doesn't look disabled, nothing that jumps as settings land, and on a touch screen, fields that don't zoom the page
// and small controls with a tap target taller than they draw.

type Colour = 'borderTopColor' | 'color' | 'boxShadow' | 'backgroundColor'

/** The contrast ratio (WCAG) of one colour of `el` (the first colour in that computed property) with the card under it. */
async function againstCard(el: Locator, prop: Colour) {
  return el.evaluate((node, prop) => {
    const rgb = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number)
    const lum = (c: string) => {
      const [r, g, b] = rgb(c).map((v) => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const colour = getComputedStyle(node)[prop]
    const card = node.closest('section, .run-bar, main')!
    let bg = getComputedStyle(card).backgroundColor
    if (bg === 'rgba(0, 0, 0, 0)') bg = getComputedStyle(document.body).backgroundColor
    const [hi, lo] = [lum(colour), lum(bg)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }, prop)
}

const runButton = (page: Page) => page.getByRole('button', { name: /^Run/ })

async function opened(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Board' }).getByText('11 lines')).toBeVisible()
  await expect(runButton(page)).toBeEnabled()
}

test('a league chip that is on is outlined in ink with a check; one that is off keeps an edge that reads', async ({ page }) => {
  await opened(page)
  const leagues = page.getByRole('group', { name: 'Leagues' })
  // By its name: "the first chip that's on" would be the next one once this one is switched off.
  const name = (await leagues.getByRole('button', { pressed: true }).first().textContent())!.trim()
  const chip = leagues.getByRole('button', { name, exact: true })
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await expect(chip.locator('svg.check')).toBeVisible()
  const ink = await chip.evaluate(() => getComputedStyle(document.body).color)
  expect(await chip.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(ink)
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'false')
  await expect(chip.locator('svg.check')).toHaveCount(0)
  expect(await againstCard(chip, 'borderTopColor')).toBeGreaterThanOrEqual(3)
  expect(await againstCard(chip, 'color')).toBeGreaterThanOrEqual(4.5)
})

test('a field and a secondary button keep an edge that reads against their card, light and dark', async ({ page }) => {
  await opened(page)
  const stake = page.getByLabel('Stake')
  const upload = page.getByRole('region', { name: 'Board' }).locator('button.secondary').first()
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: theme }).click()
    await expect.poll(() => againstCard(stake, 'borderTopColor')).toBeGreaterThanOrEqual(3)
    if (await upload.count()) expect(await againstCard(upload, 'borderTopColor')).toBeGreaterThanOrEqual(3)
  }
})

test("the auto runs switch, off, has a track edge and thumb that read against the page", async ({ page }) => {
  await opened(page)
  const toggle = page.getByRole('switch', { name: 'Auto runs' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).not.toHaveAttribute('aria-disabled', 'true')
  expect(await againstCard(toggle.locator('.switch-track'), 'boxShadow')).toBeGreaterThanOrEqual(3)
  expect(await againstCard(toggle.locator('.switch-thumb'), 'backgroundColor')).toBeGreaterThanOrEqual(3)
})

test('a disabled button stays legible, with its reason beside it', async ({ page }) => {
  await opened(page)
  const alerts = page.getByRole('region', { name: 'Phone alerts' })
  await alerts.getByRole('button', { name: 'Set up' }).click()
  const send = alerts.getByRole('button', { name: 'Send test' })
  await expect(send).toBeDisabled()
  expect(await send.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  expect(await againstCard(send, 'color')).toBeGreaterThanOrEqual(4.5)
  await expect(alerts.getByText('Set a topic to check or test it.')).toBeVisible()
})

test('Run keeps its width and its full strength while it runs, saying how far along it is', async ({ page }) => {
  await opened(page)
  const button = runButton(page)
  const idle = (await button.boundingBox())!
  // The fill Run settles on (read off a probe: Run itself eases between fills as it is enabled and hovered).
  const fill = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--primary)'
    document.body.append(probe)
    const c = getComputedStyle(probe).backgroundColor
    probe.remove()
    return c
  })
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(fill)
  // Fresh odds, so the run fetches the board (and waits on the held feed) rather than reuse one fetched a moment ago.
  await page.getByLabel(/Fresh odds/).check()
  const release = holdFeed()
  try {
    await button.click()
    await expect(button).toHaveAttribute('aria-busy', 'true')
    await expect(button).toHaveText(/^Running…/)
    const busy = (await button.boundingBox())!
    expect(Math.abs(busy.width - idle.width)).toBeLessThan(1)
    expect(await button.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    await expect.poll(() => button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(fill)
    expect(await button.evaluate((el) => getComputedStyle(el).cursor)).toBe('progress')
  } finally {
    await release()
  }
  await expect(button).toHaveText('Run', { timeout: 30_000 })
  await expect(button).not.toHaveAttribute('aria-busy')
})

test("nothing below the settings moves when they land: the cards hold their place while they load", async ({ page }) => {
  let answer!: () => void
  const waiting = new Promise<void>((r) => (answer = r))
  await page.route('**/api/options', async (route) => {
    await waiting
    await route.continue()
  })
  await page.goto('/')
  const settings = page.getByRole('region', { name: 'Run settings' })
  await expect(settings).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByRole('region', { name: 'Promotion' })).toBeVisible()
  const before = (await runButton(page).boundingBox())!
  answer()
  await expect(settings).not.toHaveAttribute('aria-busy')
  await expect(page.getByRole('group', { name: 'Leagues' })).toBeVisible()
  const after = (await runButton(page).boundingBox())!
  expect(Math.abs(after.y - before.y)).toBeLessThan(24)
})

test("forcing a theme paints the status bar its ground, and swaps colours without fading through the old", async ({ page }) => {
  await opened(page)
  const metas = () => page.locator('meta[name="theme-color"]').evaluateAll((ms) => ms.map((m) => (m as HTMLMetaElement).content))
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click()
  expect(await metas()).toEqual(['#0b0c0e', '#0b0c0e'])
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-switching') // the hold is two frames, then gone
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click()
  expect(await metas()).toEqual(['#f2f4f7', '#f2f4f7'])
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'System' }).click()
  expect(await metas()).toEqual(['#f2f4f7', '#0b0c0e'])
})

// index.html's theme-color metas are the only copy of index.css's --ground: the inline script and theme.ts read them.
test("the status bar takes index.css's ground in each scheme, a remembered theme's before the app loads", async ({ page }) => {
  await opened(page)
  const metas = () => page.locator('meta[name="theme-color"]').evaluateAll((ms) => ms.map((m) => (m as HTMLMetaElement).content))
  const ground = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ground').trim())
  await page.emulateMedia({ colorScheme: 'light' })
  const light = await ground()
  await page.emulateMedia({ colorScheme: 'dark' })
  const dark = await ground()
  expect(await metas()).toEqual([light, dark]) // as index.html gives them
  expect(light).not.toBe(dark)

  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await metas()).toEqual([dark, dark])
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'System' }).click()
  expect(await metas()).toEqual([light, dark])
})

test("the pop-up's close mark takes a tap well outside what it draws", async ({ page }) => {
  await opened(page)
  await page.getByText('Advanced').click()
  await page.getByLabel(/Fresh odds/).check() // a fresh run, so it raises a pop-up
  await runButton(page).click()
  const close = page.getByRole('button', { name: 'Dismiss notification' })
  await expect(close).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel(/Fresh odds/)).not.toBeChecked() // the run was named: fresh odds were for it alone
  const b = (await close.boundingBox())!
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'), [b.x - 6, b.y + b.height / 2])
  expect(hit).toBe('Dismiss notification')
})

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('fields are set at 16px, so focusing one never zooms the page, and zoom stays allowed', async ({ page }) => {
    await opened(page)
    await page.getByText('Advanced').click()
    const sizes = await page.locator('.field input, .field select').evaluateAll((els) =>
      els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => getComputedStyle(el).fontSize),
    )
    expect(sizes.length).toBeGreaterThan(3)
    expect(new Set(sizes)).toEqual(new Set(['16px']))
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content')
    expect(viewport).not.toMatch(/maximum-scale|user-scalable/)
  })

  test('the small controls take a tap taller than they draw', async ({ page }) => {
    await opened(page)
    const above = async (el: Locator) => {
      await el.scrollIntoViewIfNeeded() // the theme is at the foot of the page
      const b = (await el.boundingBox())!
      return page.evaluate(([x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return hit?.closest('button, summary')?.textContent?.trim() ?? null
      }, [b.x + b.width / 2, b.y - 6])
    }
    expect(await above(page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }))).toBe('Dark')
    expect(await above(page.getByText('Advanced', { exact: true }))).toBe('Advanced')
  })
})
