import type { RunNotice } from './notify'

/** The tab's mark for a run that ended while it was hidden: a title prefix and a dot on the favicon. */
const PREFIX: Record<RunNotice['kind'], string> = { finished: '✓ ', failed: '✕ ' } // taste-skill-ignore: tab title text, not UI
const DOTTED_ICON = '/favicon-dot.svg'

let saved: { title: string; icon: string | null } | null = null

const iconLink = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')

/** Mark the tab. Marking again replaces the mark rather than stacking prefixes. */
export function markTab(kind: RunNotice['kind']) {
  const link = iconLink()
  saved ??= { title: document.title, icon: link?.getAttribute('href') ?? null }
  document.title = PREFIX[kind] + saved.title
  link?.setAttribute('href', DOTTED_ICON)
}

/** Put the title and favicon back as they were before the first mark. A no-op when unmarked. */
export function clearTabMark() {
  if (!saved) return
  document.title = saved.title
  if (saved.icon !== null) iconLink()?.setAttribute('href', saved.icon)
  saved = null
}
