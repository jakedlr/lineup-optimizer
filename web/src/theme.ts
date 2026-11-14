export type Theme = 'system' | 'light' | 'dark'

const KEY = 'ppopt.theme'

/** The page's ground in each scheme (index.css `--ground`): what the phone's status bar is painted. */
export const GROUND = { light: '#f2f4f7', dark: '#0b0c0e' } as const

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

/** The status bar: the forced theme's ground in both schemes, or each scheme's own under System. */
function paintStatusBar(t: Theme) {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = t !== 'system' ? t : (meta.getAttribute('media') ?? '').includes('dark') ? 'dark' : 'light'
    meta.content = GROUND[scheme]
  }
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
