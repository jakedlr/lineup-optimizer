import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { options, report, routes } from './test/fixtures'
import type { Report } from './api'
import { fakeNotification } from './test/fakeNotification'

const board = () => Response.json({ saved_at: new Date().toISOString(), projections: 11 })

function stub(run: () => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      routes({
        'GET /api/health': () => Response.json({ status: 'ok' }),
        'GET /api/options': () => Response.json(options),
        'GET /api/board': board,
        'POST /api/run': run,
      }),
    ),
  )
}

let visibility: DocumentVisibilityState = 'visible'
function setVisibility(v: DocumentVisibilityState) {
  visibility = v
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

const icon = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.getAttribute('href')
const region = () => screen.getByRole('status', { name: /run notifications/i })

async function runOnce(body: Report | { detail: string }, status = 200) {
  stub(() => Response.json(body, { status }))
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  render(<App />)
  await user.click(await screen.findByRole('button', { name: /^run$/i }))
  return user
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' })
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'
  document.title = 'PrizePicks EV Optimizer'
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Run notification', () => {
  it('keeps a polite live region on the page before any run', async () => {
    stub(() => Response.json(report))
    render(<App />)
    await screen.findByRole('button', { name: /^run$/i })
    expect(region()).toHaveAttribute('aria-live', 'polite')
    expect(region()).toBeEmptyDOMElement()
  })

  it('pops up when a fresh run finishes', async () => {
    await runOnce(report)
    const toast = await within(region()).findByText('Run finished')
    expect(toast).toBeInTheDocument()
    expect(region()).toHaveTextContent('2 slips · best +12.3% EV (Power 2)')
  })

  it('stays quiet after a cached run', async () => {
    await runOnce({ ...report, live_requests: 0 })
    await screen.findByRole('region', { name: /best slips/i })
    expect(region()).toBeEmptyDOMElement()
  })

  it('pops up with the reason when a run fails', async () => {
    await runOnce({ detail: 'no sportsbook answered' }, 502)
    await within(region()).findByText('Run failed')
    expect(region()).toHaveTextContent('no sportsbook answered')
  })

  it('closes from its close button', async () => {
    const user = await runOnce(report)
    await within(region()).findByText('Run finished')
    await user.click(within(region()).getByRole('button', { name: /dismiss notification/i }))
    expect(region()).toBeEmptyDOMElement()
  })

  it('dismisses itself about 6s after it is seen', async () => {
    await runOnce(report)
    await within(region()).findByText('Run finished')
    act(() => vi.advanceTimersByTime(5000))
    expect(region()).toHaveTextContent('Run finished')
    act(() => vi.advanceTimersByTime(1500))
    expect(region()).toBeEmptyDOMElement()
  })

  it('a new run replaces the last pop-up', async () => {
    const user = await runOnce(report)
    await within(region()).findByText('Run finished')
    stub(() => Response.json({ detail: 'books down' }, { status: 502 }))
    await user.click(screen.getByRole('button', { name: /^run$/i }))
    await within(region()).findByText('Run failed')
    expect(within(region()).queryByText('Run finished')).not.toBeInTheDocument()
    expect(within(region()).getAllByRole('button')).toHaveLength(1)
  })
})

describe('Run notification in a hidden tab', () => {
  async function runHidden(body: Report | { detail: string }, status = 200) {
    stub(() => Response.json(body, { status }))
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /^run$/i }))
    return user
  }

  it('marks the tab, waits for you, and clears the mark when you come back', async () => {
    let finish!: (r: Response) => void
    stub(() => new Promise<Response>((r) => (finish = r)))
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /^run$/i }))

    setVisibility('hidden')
    await act(async () => finish(Response.json(report)))
    await within(region()).findByText('Run finished')
    expect(document.title).toBe('✓ PrizePicks EV Optimizer') // taste-skill-ignore: the tab title prefix under test
    expect(icon()).not.toBe('/favicon.svg')

    act(() => vi.advanceTimersByTime(20_000))
    expect(region()).toHaveTextContent('Run finished')

    setVisibility('visible')
    expect(document.title).toBe('PrizePicks EV Optimizer')
    expect(icon()).toBe('/favicon.svg')
    act(() => vi.advanceTimersByTime(5000))
    expect(region()).toHaveTextContent('Run finished')
    act(() => vi.advanceTimersByTime(1500))
    expect(region()).toBeEmptyDOMElement()
  })

  it('marks a failed run with a cross', async () => {
    visibility = 'hidden'
    await runHidden({ detail: 'books down' }, 502)
    await within(region()).findByText('Run failed')
    expect(document.title).toBe('✕ PrizePicks EV Optimizer') // taste-skill-ignore: the tab title prefix under test
    setVisibility('visible')
    expect(document.title).toBe('PrizePicks EV Optimizer')
  })

  it('leaves the tab alone after a cached run', async () => {
    visibility = 'hidden'
    await runHidden({ ...report, live_requests: 0 })
    await screen.findByRole('region', { name: /best slips/i })
    expect(document.title).toBe('PrizePicks EV Optimizer')
    expect(icon()).toBe('/favicon.svg')
  })

  it('does not stack marks when two runs end while hidden', async () => {
    visibility = 'hidden'
    const user = await runHidden(report)
    await within(region()).findByText('Run finished')
    stub(() => Response.json({ detail: 'books down' }, { status: 502 }))
    await user.click(screen.getByRole('button', { name: /^run$/i }))
    await within(region()).findByText('Run failed')
    expect(document.title).toBe('✕ PrizePicks EV Optimizer') // taste-skill-ignore: the tab title prefix under test
    setVisibility('visible')
    expect(document.title).toBe('PrizePicks EV Optimizer')
    expect(icon()).toBe('/favicon.svg')
  })
})

describe('System notification', () => {
  const toggle = () => screen.getByLabelText(/notify me when runs finish/i)

  async function openSettings() {
    stub(() => Response.json(report))
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)
    await user.click(await screen.findByText(/advanced/i))
    return user
  }

  /** Ticks the toggle (granting permission), then runs once with the tab hidden. */
  async function runHiddenWithToggle(body: Report | { detail: string } = report, status = 200) {
    const N = fakeNotification('default', 'granted')
    const user = await openSettings()
    await user.click(toggle())
    await waitFor(() => expect(toggle()).toBeChecked())
    stub(() => Response.json(body, { status }))
    visibility = 'hidden'
    await user.click(screen.getByRole('button', { name: /^run$/i }))
    return { N, user }
  }

  beforeEach(() => {
    vi.stubGlobal('isSecureContext', true)
  })

  it('is off by default and remembered once on', async () => {
    fakeNotification('granted')
    const user = await openSettings()
    expect(toggle()).not.toBeChecked()
    expect(toggle()).toBeEnabled()
    await user.click(toggle())
    expect(toggle()).toBeChecked()
    expect(JSON.parse(localStorage.getItem('ppopt.settings.v1')!).notify).toBe(true)

    cleanup()
    await openSettings()
    expect(toggle()).toBeChecked()
  })

  it('loads an older save without it as off', async () => {
    fakeNotification('granted')
    localStorage.setItem('ppopt.settings.v1', JSON.stringify({ stake: '7' }))
    await openSettings()
    expect(toggle()).not.toBeChecked()
  })

  it('asks for permission when turned on', async () => {
    const N = fakeNotification('default', 'granted')
    const user = await openSettings()
    await user.click(toggle())
    expect(N.requestPermission).toHaveBeenCalledOnce()
    await waitFor(() => expect(toggle()).toBeChecked())
  })

  it('goes back off with a note when permission is denied', async () => {
    fakeNotification('default', 'denied')
    const user = await openSettings()
    await user.click(toggle())
    await screen.findByText('Notifications are blocked for this site in your browser')
    expect(toggle()).not.toBeChecked()
    expect(toggle()).toBeDisabled()
    expect(toggle()).toHaveAccessibleDescription('Notifications are blocked for this site in your browser')
    expect(JSON.parse(localStorage.getItem('ppopt.settings.v1')!).notify).toBe(false)
  })

  it('goes back off quietly when the prompt is dismissed', async () => {
    fakeNotification('default', 'default')
    const user = await openSettings()
    await user.click(toggle())
    await waitFor(() => expect(toggle()).not.toBeChecked())
    expect(toggle()).toBeEnabled()
    expect(screen.queryByText(/blocked/i)).not.toBeInTheDocument()
  })

  it('is disabled with the note when already blocked', async () => {
    fakeNotification('denied')
    await openSettings()
    expect(toggle()).toBeDisabled()
    expect(toggle()).toHaveAccessibleDescription('Notifications are blocked for this site in your browser')
  })

  it('is disabled with a reason where notifications cannot work', async () => {
    fakeNotification('granted')
    vi.stubGlobal('isSecureContext', false)
    await openSettings()
    expect(toggle()).toBeDisabled()
    expect(toggle()).toHaveAccessibleDescription('Needs a desktop browser on localhost or HTTPS')
  })

  it('without the API, the pop-up and tab mark still work', async () => {
    const user = await openSettings()
    expect(toggle()).toBeDisabled()
    visibility = 'hidden'
    await user.click(screen.getByRole('button', { name: /^run$/i }))
    await within(region()).findByText('Run finished')
    expect(document.title).toBe('\u2713 PrizePicks EV Optimizer')
  })

  it('a fresh run in a hidden tab sends one notification', async () => {
    const { N } = await runHiddenWithToggle()
    await within(region()).findByText('Run finished')
    expect(N.made).toHaveLength(1)
    expect(N.made[0].title).toBe('Run finished')
    expect(N.made[0].options).toEqual({ body: '2 slips · best +12.3% EV (Power 2)', tag: 'ppopt-run' })
  })

  it('a second hidden run closes the first notification', async () => {
    const { N, user } = await runHiddenWithToggle()
    await within(region()).findByText('Run finished')
    stub(() => Response.json({ detail: 'books down' }, { status: 502 }))
    await user.click(screen.getByRole('button', { name: /^run$/i }))
    await within(region()).findByText('Run failed')
    expect(N.made).toHaveLength(2)
    expect(N.made[0].close).toHaveBeenCalled()
    expect(N.made[1].title).toBe('Run failed')
    expect(N.made[1].options?.body).toBe('books down')
  })

  it('sends nothing when the toggle is off', async () => {
    const N = fakeNotification('granted')
    const user = await openSettings()
    visibility = 'hidden'
    await user.click(screen.getByRole('button', { name: /^run$/i }))
    await within(region()).findByText('Run finished')
    expect(N.made).toHaveLength(0)
  })

  it('sends nothing when the tab is visible', async () => {
    const N = fakeNotification('granted')
    const user = await openSettings()
    await user.click(toggle())
    await user.click(screen.getByRole('button', { name: /^run$/i }))
    await within(region()).findByText('Run finished')
    expect(N.made).toHaveLength(0)
  })

  it('sends nothing after a cached run', async () => {
    const { N } = await runHiddenWithToggle({ ...report, live_requests: 0 })
    await screen.findByRole('region', { name: /best slips/i })
    expect(N.made).toHaveLength(0)
  })

  it('a throwing constructor breaks nothing: the pop-up still shows', async () => {
    const N = fakeNotification('granted')
    N.throws = new TypeError('Illegal constructor')
    const user = await openSettings()
    await user.click(toggle())
    visibility = 'hidden'
    await user.click(screen.getByRole('button', { name: /^run$/i }))
    await within(region()).findByText('Run finished')
    expect(document.title).toBe('\u2713 PrizePicks EV Optimizer')
  })

  it('clicking it focuses the tab', async () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    const { N } = await runHiddenWithToggle()
    await within(region()).findByText('Run finished')
    act(() => N.made[0].onclick?.(new Event('click')))
    expect(focus).toHaveBeenCalled()
    expect(N.made[0].close).toHaveBeenCalled()
    focus.mockRestore()
  })
})
