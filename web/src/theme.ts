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

/** Set on <html> (see the inline script in index.html, which does the same before first paint). */
export function applyTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  try {
    if (t === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
  } catch {
    // not remembered; still applied
  }
}
