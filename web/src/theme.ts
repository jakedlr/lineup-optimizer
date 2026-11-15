export type Theme = 'system' | 'light' | 'dark'

const KEY = 'ppopt.theme'

export function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

let latestHold = 0

/**
 * Make a change of colours with every transition held, so the page swaps at once instead of fading each control
 * through the old theme. The hold lasts two frames: the change is styled in the first with transitions off.
 */
export function quietly(change: () => void) {
  const root = document.documentElement
  const hold = ++latestHold // only the latest change's frames end the hold
  root.dataset.themeSwitching = ''
  change()
  const frame = (f: () => void) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : setTimeout(f, 16)
  frame(() =>
    frame(() => {
      if (hold === latestHold) delete root.dataset.themeSwitching
    }),
  )
}

/**
 * The status bar: the forced theme's ground in both schemes, or each scheme's own under System. Each theme-color meta
 * in index.html starts out as its scheme's ground (index.css `--ground`), and keeps that in `data-ground` once painted.
 */
function paintStatusBar(t: Theme) {
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')]
  const schemeOf = (m: HTMLMetaElement) => ((m.getAttribute('media') ?? '').includes('dark') ? 'dark' : 'light')
  const ground: Partial<Record<'light' | 'dark', string>> = {}
  for (const m of metas) ground[schemeOf(m)] = m.dataset.ground ??= m.content
  for (const m of metas) m.content = ground[t === 'system' ? schemeOf(m) : t] ?? m.dataset.ground!
}

/** Set on <html> (see the inline script in index.html, which does the same before first paint). */
export function applyTheme(t: Theme) {
  quietly(() => {
    if (t === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = t
  })
  paintStatusBar(t)
  try {
    if (t === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
  } catch {
    // not remembered; still applied
  }
}

/** While the theme follows the system, hold transitions as the system scheme flips. Returns the way to stop. */
export function watchSystemTheme(): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const scheme = window.matchMedia('(prefers-color-scheme: dark)')
  const flip = () => quietly(() => {})
  scheme.addEventListener('change', flip)
  return () => scheme.removeEventListener('change', flip)
}
