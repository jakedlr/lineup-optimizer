import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, GROUND, watchSystemTheme } from './theme'

// Sprint 11: switching theme swaps colours at once (no transition ghosting) and keeps the phone's status bar in step.

const root = document.documentElement
const metas = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')]
let frames: FrameRequestCallback[] = []
const nextFrame = () => {
  const run = frames
  frames = []
  run.forEach((f) => f(0))
}

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f))
  document.head.innerHTML = `
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="${GROUND.light}" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${GROUND.dark}" />`
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete root.dataset.theme
  delete root.dataset.themeSwitching
  localStorage.clear()
})

describe('applyTheme', () => {
  it('holds every transition while the colours swap, for two frames', () => {
    applyTheme('dark')
    expect(root.dataset.theme).toBe('dark')
    expect(root).toHaveAttribute('data-theme-switching')
    nextFrame()
    expect(root).toHaveAttribute('data-theme-switching')
    nextFrame()
    expect(root).not.toHaveAttribute('data-theme-switching')
  })

  it("doesn't let an earlier switch's frames end a later one's hold", () => {
    applyTheme('dark')
    nextFrame()
    applyTheme('light')
    nextFrame()
    expect(root).toHaveAttribute('data-theme-switching')
    nextFrame()
    expect(root).not.toHaveAttribute('data-theme-switching')
  })

  it("paints the status bar the forced theme's ground, and each scheme's own under System", () => {
    applyTheme('dark')
    expect(metas().map((m) => m.content)).toEqual([GROUND.dark, GROUND.dark])
    applyTheme('light')
    expect(metas().map((m) => m.content)).toEqual([GROUND.light, GROUND.light])
    applyTheme('system')
    expect(metas().map((m) => m.content)).toEqual([GROUND.light, GROUND.dark])
  })
})

describe('watchSystemTheme', () => {
  it('holds transitions when the system scheme flips, and stops when asked', () => {
    const listeners: (() => void)[] = []
    const mq = {
      addEventListener: (_: string, f: () => void) => listeners.push(f),
      removeEventListener: (_: string, f: () => void) => listeners.splice(listeners.indexOf(f), 1),
    }
    vi.stubGlobal('matchMedia', () => mq)
    const stop = watchSystemTheme()
    listeners.forEach((f) => f())
    expect(root).toHaveAttribute('data-theme-switching')
    nextFrame()
    nextFrame()
    expect(root).not.toHaveAttribute('data-theme-switching')
    stop()
    expect(listeners).toHaveLength(0)
  })

  it('does nothing where the browser has no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(() => watchSystemTheme()()).not.toThrow()
  })
})
