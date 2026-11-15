import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { fakeServer, localTime, options, report, routes, runInfo, streamed } from './test/fixtures'

// Sprint 10: alerts through ntfy (GLOSSARY: Alert, Alert tier, Qualifying leg). The panel edits the alert settings
// the server keeps; the latest run says how its alert went.

let server: ReturnType<typeof fakeServer>

function stub(table: Parameters<typeof routes>[0] = {}) {
  const fn = vi.fn(
    routes({
      ...server.routes,
      'GET /api/health': () => Response.json({ status: 'ok' }),
      'GET /api/options': () => Response.json(options),
      'GET /api/board': () => Response.json({ saved_at: new Date().toISOString(), projections: 11, source: 'fetched' }),
      'POST /api/run': () => Response.json(report),
      ...table,
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

const sent = (f: ReturnType<typeof stub>, key: string) =>
  f.mock.calls
    .filter(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key)
    .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : undefined))
const alertPatches = (f: ReturnType<typeof stub>) => sent(f, 'PATCH /api/alerts')

beforeEach(() => {
  server = fakeServer()
  server.state.settings = { ...options.defaults, saved: true }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const panel = () => screen.getByRole('region', { name: 'Phone alerts' })
const details = () => panel().querySelector('details')!
const topic = () => within(panel()).getByLabelText('Topic')
const tier = (name: 'High' | 'Medium') => within(panel()).getByRole('group', { name: `${name} tier` })

/** Open the page with a topic already set, and the panel opened. */
async function opened(alerts: Partial<typeof server.state.alerts> = {}) {
  server.state.alerts = { ...server.state.alerts, topic: 'pp-abc', saved: true, updated_at: '2026-11-14T11:00:00+00:00', ...alerts }
  const fetchMock = stub()
  render(<App />)
  await waitFor(() => expect(topic()).toHaveValue(server.state.alerts.topic))
  if (!details().open) await userEvent.click(within(panel()).getByText('Phone alerts'))
  return fetchMock
}

describe('Phone alerts panel', () => {
  it('starts folded with no topic set, saying auto runs send none, and offers to set it up', async () => {
    stub()
    render(<App />)
    await waitFor(() => expect(within(panel()).getByText(/no topic: auto runs send no alerts/i)).toBeInTheDocument())
    expect(details().open).toBe(false)
    expect(topic()).toHaveValue('')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Set up' }))
    expect(details().open).toBe(true)
    expect(within(panel()).queryByRole('button', { name: 'Set up' })).not.toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: 'Send test' })).toBeDisabled()
    expect(within(panel()).getByText('Set a topic to check or test it.')).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: 'Check' })).toHaveAccessibleDescription('Set a topic to check or test it.')
  })

  // Sprint 12 review: it starts folded on every load, even where an older build remembered it open.
  it('starts folded on every load, even where this browser once left it open', async () => {
    localStorage.setItem('ppopt.alertsOpen', '1')
    server.state.alerts = { ...server.state.alerts, topic: 'pp-abc', saved: true }
    stub()
    const { unmount } = render(<App />)
    await waitFor(() => expect(topic()).toHaveValue('pp-abc'))
    expect(details().open).toBe(false)
    await userEvent.click(within(panel()).getByText('Phone alerts'))
    await waitFor(() => expect(details().open).toBe(true))
    unmount()
    render(<App />)
    await waitFor(() => expect(topic()).toHaveValue('pp-abc'))
    expect(details().open).toBe(false)
  })

  it('is collapsed once a topic is set, naming it', async () => {
    server.state.alerts = { ...server.state.alerts, topic: 'pp-abc', saved: true }
    stub()
    render(<App />)
    await waitFor(() => expect(topic()).toHaveValue('pp-abc'))
    expect(details().open).toBe(false)
    expect(within(panel()).getByText('pp-abc on ntfy.sh')).toBeInTheDocument()
  })

  it('saves a topic once typing pauses, and never one that is not valid', async () => {
    const fetchMock = await opened()
    await userEvent.clear(topic())
    await userEvent.type(topic(), 'pp new')
    expect(within(panel()).getByText(/letters, digits, - or _/)).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 700))
    expect(alertPatches(fetchMock)).toEqual([])

    await userEvent.clear(topic())
    await userEvent.type(topic(), 'pp-new')
    await waitFor(() => expect(alertPatches(fetchMock)).toEqual([{ topic: 'pp-new' }]))
    expect(within(panel()).queryByText(/letters, digits, - or _/)).not.toBeInTheDocument()
  })

  it("Random picks a hard-to-guess topic and saves it at once; the note says why it's needed", async () => {
    const fetchMock = await opened()
    expect(within(panel()).getByText(/anyone with a public topic's name can read it/i)).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Random' }))
    const value = (topic() as HTMLInputElement).value
    expect(value).toMatch(/^pp-[a-z0-9]{12}$/)
    await waitFor(() => expect(alertPatches(fetchMock)).toEqual([{ topic: value }]))
    const link = within(panel()).getByRole('link', { name: `ntfy.sh/${value}` })
    expect(link).toHaveAttribute('href', `https://ntfy.sh/${value}`)
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('Check asks about the topic as typed and says what it found, as advice', async () => {
    server.state.check = (t) =>
      Response.json(
        t === 'pp-busy'
          ? { state: 'recent', detail: '3 messages posted to this topic recently: someone else may be using it' }
          : { state: 'unused', detail: 'no recent messages on this topic' },
      )
    const fetchMock = await opened()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Check' }))
    expect(await within(panel()).findByText('Looks unused: no recent messages on this topic')).toBeInTheDocument()

    await userEvent.clear(topic())
    await userEvent.type(topic(), 'pp-busy')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Check' }))
    const busy = await within(panel()).findByText(/^In use: 3 messages posted/)
    expect(busy).toHaveClass('warn')
    expect(sent(fetchMock, 'POST /api/alerts/check')).toEqual([{ topic: 'pp-abc' }, { topic: 'pp-busy' }])

    await userEvent.type(topic(), '!')
    expect(within(panel()).queryByText(/^In use/)).not.toBeInTheDocument() // the answer was about another topic
  })

  it("Check says when the topic is reserved, or why it couldn't tell", async () => {
    let answer = { state: 'reserved', detail: 'someone has reserved this topic: only they can read it' }
    server.state.check = () => Response.json(answer)
    await opened()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Check' }))
    expect(await within(panel()).findByText('Reserved: someone has reserved this topic: only they can read it')).toHaveClass('warn')
    answer = { state: 'unknown', detail: "couldn't reach https://ntfy.sh ([Errno 111] Connection refused)" }
    await userEvent.click(within(panel()).getByRole('button', { name: 'Check' }))
    expect(await within(panel()).findByText(/^Couldn't tell: couldn't reach/)).toBeInTheDocument()
  })

  it('Send test saves a topic still waiting first, then says it was sent', async () => {
    const fetchMock = await opened()
    await userEvent.clear(topic())
    await userEvent.type(topic(), 'pp-fresh')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send test' }))
    expect(await within(panel()).findByText('Test alert sent to pp-fresh')).toBeInTheDocument()
    const order = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`).filter((k) => k.includes('alerts'))
    expect(order.indexOf('PATCH /api/alerts')).toBeLessThan(order.indexOf('POST /api/alerts/test'))
    expect(server.state.alerts.topic).toBe('pp-fresh')
  })

  it("Send test doesn't go to the old topic when the new one couldn't be saved", async () => {
    server.routes['PATCH /api/alerts'] = () => Response.json({ detail: 'disk full' }, { status: 500 })
    const fetchMock = await opened()
    await userEvent.clear(topic())
    await userEvent.type(topic(), 'pp-fresh')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send test' }))
    expect(await within(panel()).findByText("Test alert not sent: the topic couldn't be saved")).toBeInTheDocument()
    expect(sent(fetchMock, 'POST /api/alerts/test')).toEqual([])
  })

  it("Send test says why it wasn't sent", async () => {
    server.state.test = () => Response.json({ detail: 'ntfy refused it (403: forbidden)' }, { status: 502 })
    await opened()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send test' }))
    expect(await within(panel()).findByText('Test alert not sent: ntfy refused it (403: forbidden)')).toBeInTheDocument()
  })

  it('keeps the server and the access token tucked away; the token is set and cleared, never shown', async () => {
    const fetchMock = await opened()
    await userEvent.click(within(panel()).getByText('Server and token'))
    const url = within(panel()).getByLabelText('Server')
    expect(url).toHaveValue('https://ntfy.sh')
    await userEvent.clear(url)
    await userEvent.type(url, 'ntfy.lan')
    expect(within(panel()).getByText(/http\(s\) address/)).toBeInTheDocument()
    await userEvent.clear(url)
    await userEvent.type(url, 'http://ntfy.lan:8080')
    await waitFor(() => expect(alertPatches(fetchMock)).toEqual([{ server: 'http://ntfy.lan:8080' }]))

    const token = within(panel()).getByLabelText('Access token')
    expect(token).toHaveAttribute('type', 'password')
    await userEvent.type(token, 'tk_secret')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Save token' }))
    expect(await within(panel()).findByText('Token set')).toBeInTheDocument()
    expect(alertPatches(fetchMock).at(-1)).toEqual({ token: 'tk_secret' })
    expect(within(panel()).queryByDisplayValue('tk_secret')).not.toBeInTheDocument()

    await userEvent.click(within(panel()).getByRole('button', { name: 'Clear token' }))
    await waitFor(() => expect(alertPatches(fetchMock).at(-1)).toEqual({ token: '' }))
    expect(await within(panel()).findByLabelText('Access token')).toHaveValue('')
  })

  it('shows each tier with its priority, switch, edge bar and qualifying legs', async () => {
    await opened()
    const high = tier('High')
    expect(within(high).getByRole('switch', { name: /high/i })).toHaveAttribute('aria-checked', 'true')
    expect(within(high).getByText('priority 4')).toBeInTheDocument()
    expect(within(high).getByLabelText('Edge')).toHaveValue(1)
    expect(within(high).getByLabelText('Qualifying legs')).toHaveValue(3)
    expect(within(high).getByText('3 or more games with a leg ≥ +1.0%')).toBeInTheDocument()
    expect(within(tier('Medium')).getByText('priority 3')).toBeInTheDocument()
    expect(within(tier('Medium')).getByText('3 or more games with a leg ≥ +0.5%')).toBeInTheDocument()
    expect(within(high).getByText('%')).toBeInTheDocument() // the edge is in %, as the report reads it
    expect(within(high).queryByText('pts')).not.toBeInTheDocument()
    expect(within(high).queryByText('+')).not.toBeInTheDocument() // a lone + read as a stepper
    const neither = within(panel()).getByText('Neither met: priority 1 (silent). Unchanged legs repeat at priority 1.')
    expect(neither.closest('details')).not.toHaveAttribute('open') // folded away until asked for
  })

  it('heads the tier columns once, over the edge and qualifying legs', async () => {
    await opened()
    const header = panel().querySelector('.tier-head')!
    expect(header).toHaveAttribute('aria-hidden', 'true')
    expect(header).toHaveTextContent('EdgeQualifying legs')
  })

  it('saves a tier switched off, and an edge or leg count, each on its own', async () => {
    const fetchMock = await opened()
    await userEvent.click(within(tier('Medium')).getByRole('switch'))
    expect(within(tier('Medium')).getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(within(tier('Medium')).getByText('Off')).toBeInTheDocument()
    await waitFor(() => expect(alertPatches(fetchMock)).toEqual([{ medium: { enabled: false } }]))

    const edge = within(tier('High')).getByLabelText('Edge')
    await userEvent.clear(edge)
    await userEvent.type(edge, '1.5')
    const legs = within(tier('High')).getByLabelText('Qualifying legs')
    await userEvent.clear(legs)
    await userEvent.type(legs, '9')
    expect(within(tier('High')).getByText(/whole number from 1 to 6/)).toBeInTheDocument()
    await waitFor(() => expect(alertPatches(fetchMock)).toEqual([{ medium: { enabled: false } }, { high: { edge: 1.5 } }]))
    expect(server.state.alerts.high).toEqual({ enabled: true, edge: 1.5, legs: 3 })
  })

  it("warns when medium's bar is above high's while both are on", async () => {
    await opened({ medium: { enabled: true, edge: 2, legs: 3 } })
    expect(within(panel()).getByText(/medium's edge bar is above high's/i)).toBeInTheDocument()
    await userEvent.click(within(tier('High')).getByRole('switch'))
    expect(within(panel()).queryByText(/medium's edge bar is above high's/i)).not.toBeInTheDocument()
  })

  it('says quietly when a change could not be saved', async () => {
    server.routes['PATCH /api/alerts'] = () => Response.json({ detail: 'disk full' }, { status: 500 })
    await opened()
    await userEvent.click(within(tier('High')).getByRole('switch'))
    expect(await within(panel()).findByText("Couldn't save alert settings: disk full")).toBeInTheDocument()
  })

  describe('in step with other tabs', () => {
    it("shows a change saved in another tab within one look, keeping what's being edited here", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const fetchMock = await opened()
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const legs = within(tier('High')).getByLabelText('Qualifying legs')
      await user.clear(legs) // half-typed: not saved yet
      server.patchAlerts({ topic: 'pp-other', medium: { edge: 0.8 } })
      await act(() => vi.advanceTimersByTimeAsync(5000))
      await waitFor(() => expect(topic()).toHaveValue('pp-other'))
      expect(within(tier('Medium')).getByLabelText('Edge')).toHaveValue(0.8)
      expect(legs).toHaveValue(null)
      await user.type(legs, '2')
      await act(() => vi.advanceTimersByTimeAsync(600))
      await waitFor(() => expect(alertPatches(fetchMock)).toEqual([{ high: { legs: 2 } }]))
      expect(server.state.alerts).toMatchObject({ topic: 'pp-other', medium: { edge: 0.8 }, high: { legs: 2 } })
    })

    it('sends a change still waiting when the page goes away, at once', async () => {
      const fetchMock = await opened()
      await userEvent.clear(topic())
      await userEvent.type(topic(), 'pp-leaving')
      window.dispatchEvent(new Event('pagehide'))
      const last = fetchMock.mock.calls.filter(([url]) => url === '/api/alerts').at(-1)![1]!
      expect(last.method).toBe('PATCH')
      expect(last.keepalive).toBe(true)
      expect(JSON.parse(String(last.body))).toEqual({ topic: 'pp-leaving' })
    })
  })

  describe("alert titles' clock", () => {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone
    const other = here === 'Asia/Tokyo' ? 'Europe/Oslo' : 'Asia/Tokyo'
    const zone = () => within(panel()).getByLabelText('Alert times in')

    it("is set to this browser's time zone the first time, while the server has none", async () => {
      server.state.alerts = { ...server.state.alerts, timezone: null }
      const fetchMock = stub()
      render(<App />)
      await waitFor(() => expect(alertPatches(fetchMock)).toEqual([{ timezone: here }]))
      await userEvent.click(within(panel()).getByText('Phone alerts'))
      expect(zone()).toHaveValue(here)
    })

    it('is left alone once one is chosen, even when it is not this browser\'s', async () => {
      server.state.alerts = { ...server.state.alerts, timezone: other }
      const fetchMock = stub()
      render(<App />)
      await waitFor(() => expect(topic()).toBeInTheDocument())
      await userEvent.click(within(panel()).getByText('Phone alerts'))
      await waitFor(() => expect(zone()).toHaveValue(other))
      await new Promise((r) => setTimeout(r, 50))
      expect(alertPatches(fetchMock)).toEqual([])
    })

    it('is chosen after the tiers, and saved as the other fields are', async () => {
      const fetchMock = await opened()
      expect(zone().compareDocumentPosition(tier('Medium')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
      expect(within(panel()).getByText('Server and token').closest('details')!.contains(zone())).toBe(false)
      expect(zone()).toHaveValue(here)
      await userEvent.selectOptions(zone(), other)
      await waitFor(() => expect(alertPatches(fetchMock)).toEqual([{ timezone: other }]))
      expect(server.state.alerts.timezone).toBe(other)
    })

    // Sprint 11 review: some 400 zone labels were built on every mount, though the panel opens folded.
    it('builds no list of zones while the panel is folded', async () => {
      const listed = vi.spyOn(Intl, 'supportedValuesOf')
      server.state.alerts = { ...server.state.alerts, topic: 'pp-abc', saved: true, updated_at: '2026-11-14T11:00:00+00:00' }
      stub()
      render(<App />)
      await waitFor(() => expect(topic()).toHaveValue('pp-abc'))
      expect(details().open).toBe(false)
      expect(listed).not.toHaveBeenCalledWith('timeZone')
      await userEvent.click(within(panel()).getByText('Phone alerts'))
      expect(within(zone()).getByRole('option', { name: /^Tokyo \(GMT\+9\)$/ })).toBeInTheDocument()
      listed.mockRestore()
    })

    it("names each zone by its city and offset, this browser's first", async () => {
      await opened()
      const first = within(zone()).getAllByRole('option')[0] as HTMLOptionElement
      expect(first.value).toBe(here)
      const tokyo = within(zone()).getByRole('option', { name: /^Tokyo \(GMT\+9\)$/ }) as HTMLOptionElement
      expect(tokyo.value).toBe('Asia/Tokyo')
    })
  })

  describe('folded summary', () => {
    const summary = () => panel().querySelector('.alerts-summary')!

    it('names the saved topic and server, not what is being typed', async () => {
      const fetchMock = await opened()
      await userEvent.clear(topic())
      await userEvent.type(topic(), 'pp new') // not valid: the server keeps pp-abc
      expect(summary()).toHaveTextContent('pp-abc on ntfy.sh')
      await userEvent.click(within(panel()).getByText('Server and token'))
      const url = within(panel()).getByLabelText('Server')
      await userEvent.clear(url)
      await userEvent.type(url, 'ntfy.lan')
      expect(summary()).toHaveTextContent('pp-abc on ntfy.sh')

      await userEvent.clear(topic())
      await userEvent.type(topic(), 'pp-new')
      expect(summary()).toHaveTextContent('pp-abc on ntfy.sh') // until it is saved
      await waitFor(() => expect(alertPatches(fetchMock)).toEqual([{ topic: 'pp-new' }]))
      await waitFor(() => expect(summary()).toHaveTextContent('pp-new on ntfy.sh'))
    })

    it('says no alerts go only when the server has no topic', async () => {
      const fetchMock = stub()
      render(<App />)
      await waitFor(() => expect(summary()).toHaveTextContent('No topic: auto runs send no alerts'))
      await userEvent.type(topic(), 'pp-first')
      expect(summary()).toHaveTextContent('No topic: auto runs send no alerts')
      await waitFor(() => expect(alertPatches(fetchMock)).toEqual([{ topic: 'pp-first' }]))
      await waitFor(() => expect(summary()).toHaveTextContent('pp-first on ntfy.sh'))
    })
  })

  describe('Check and Send test go through the saved server', () => {
    const button = (name: 'Check' | 'Send test') => within(panel()).getByRole('button', { name })
    const order = (f: ReturnType<typeof stub>) =>
      f.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`).filter((k) => k.includes('alerts') && k !== 'GET /api/alerts')

    async function typeServer(value: string) {
      if (!within(panel()).queryByLabelText('Server')) await userEvent.click(within(panel()).getByText('Server and token'))
      const url = within(panel()).getByLabelText('Server')
      await userEvent.clear(url)
      await userEvent.type(url, value)
    }

    it('Check saves a server still waiting first', async () => {
      const fetchMock = await opened()
      await typeServer('http://ntfy.lan:8080')
      await userEvent.click(button('Check'))
      expect(await within(panel()).findByText('Looks unused: no recent messages on this topic')).toBeInTheDocument()
      expect(order(fetchMock)).toEqual(['PATCH /api/alerts', 'POST /api/alerts/check'])
      expect(alertPatches(fetchMock)).toEqual([{ server: 'http://ntfy.lan:8080' }])
    })

    it("Check doesn't go to the old server when the new one couldn't be saved", async () => {
      server.routes['PATCH /api/alerts'] = () => Response.json({ detail: 'disk full' }, { status: 500 })
      const fetchMock = await opened()
      await typeServer('http://ntfy.lan:8080')
      await userEvent.click(button('Check'))
      expect(await within(panel()).findByText("Couldn't check: the server couldn't be saved")).toBeInTheDocument()
      expect(sent(fetchMock, 'POST /api/alerts/check')).toEqual([])
    })

    it("Send test doesn't go to the old server when the new one couldn't be saved", async () => {
      server.routes['PATCH /api/alerts'] = () => Response.json({ detail: 'disk full' }, { status: 500 })
      const fetchMock = await opened()
      await typeServer('http://ntfy.lan:8080')
      await userEvent.click(button('Send test'))
      expect(await within(panel()).findByText("Test alert not sent: the server couldn't be saved")).toBeInTheDocument()
      expect(sent(fetchMock, 'POST /api/alerts/test')).toEqual([])
    })

    it('say what they are doing while they go, and the other stays as it was', async () => {
      let answer!: () => void
      server.state.check = () => new Promise<Response>((r) => (answer = () => r(Response.json({ state: 'unused', detail: 'quiet' })))) as unknown as Response
      await opened()
      await userEvent.click(button('Check'))
      const checking = within(panel()).getByRole('button', { name: 'Checking…' })
      expect(checking).toHaveAttribute('aria-busy', 'true')
      expect(checking).toBeEnabled()
      expect(button('Send test')).toBeEnabled()
      expect(button('Send test')).not.toHaveAttribute('aria-busy')
      await waitFor(() => expect(answer).toBeTypeOf('function'))
      act(() => answer())
      expect(await within(panel()).findByText('Looks unused: quiet')).toBeInTheDocument()
      expect(button('Check')).not.toHaveAttribute('aria-busy')
    })

    it('are off while the server typed is not valid', async () => {
      await opened()
      await typeServer('ntfy.lan')
      expect(button('Check')).toBeDisabled()
      expect(button('Send test')).toBeDisabled()
      await typeServer('https://ntfy.lan')
      expect(button('Check')).toBeEnabled()
      expect(button('Send test')).toBeEnabled()
    })

    it("drop what they said once the server changes: it was about another server", async () => {
      await opened()
      await userEvent.click(button('Check'))
      expect(await within(panel()).findByText('Looks unused: no recent messages on this topic')).toBeInTheDocument()
      await userEvent.click(button('Send test'))
      expect(await within(panel()).findByText('Test alert sent to pp-abc')).toBeInTheDocument()
      await typeServer('https://ntfy.lan')
      expect(within(panel()).queryByText(/^Looks unused/)).not.toBeInTheDocument()
      expect(within(panel()).queryByText(/^Test alert sent/)).not.toBeInTheDocument()
    })
  })
})

describe("The latest run's alert", () => {
  const alertSent = { sent: true, priority: 4, title: 'HIGH · 1 leg ≥ +1.0% · 14:15', error: null }

  it('says it was sent, and at what priority, beside the run mark', async () => {
    server.state.latest = { ...runInfo('auto', localTime(14, 15)), finished_at: localTime(14, 16), report, alert: alertSent }
    stub()
    render(<App />)
    expect(await screen.findByText('Alert sent · priority 4')).toBeInTheDocument()
    expect(screen.getByText('Auto run · 14:15')).toBeInTheDocument()
  })

  it("warns when it wasn't delivered, and why", async () => {
    const error = "couldn't reach https://ntfy.sh ([Errno 111] Connection refused)"
    server.state.latest = { ...runInfo('auto', localTime(14, 15)), finished_at: localTime(14, 16), report, alert: { ...alertSent, sent: false, error } }
    stub()
    render(<App />)
    const note = await screen.findByText(`Alert not delivered: ${error}`)
    expect(note).toHaveClass('warn')
  })

  it('shows nothing while it may still be sending, then what became of it at the next look', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    server.state.latest = { ...runInfo('auto', localTime(14, 15)), finished_at: localTime(14, 16), report, alert: null }
    stub()
    render(<App />)
    await screen.findByText('Auto run · 14:15')
    expect(screen.queryByText(/^Alert (sent|not delivered)/)).not.toBeInTheDocument()
    server.state.latest = { ...server.state.latest, alert: alertSent }
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(await screen.findByText('Alert sent · priority 4')).toBeInTheDocument()
  })

  it("is shown beside a failed run's mark too", async () => {
    const off = { sent: true, priority: 4, title: 'AUTO RUNS OFF · board fetch failed · 14:15', error: null }
    server.state.latest = { ...runInfo('auto', localTime(14, 15)), finished_at: localTime(14, 16), error: 'the board fetch failed', alert: off }
    stub()
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Auto run · 14:15')
    expect(await screen.findByText('Alert sent · priority 4')).toBeInTheDocument()
  })

  it('is shown as soon as the run is, from the report the page opens on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    server.state.latest = { ...runInfo('auto', localTime(14, 15)), finished_at: localTime(14, 16), report, alert: alertSent }
    const status = server.routes['GET /api/status']
    stub({
      'GET /api/status': async (init) => {
        const answer = await (await status(init)).json()
        return Response.json({ ...answer, latest: answer.latest && { ...answer.latest, alert: null } }) // not heard yet
      },
    })
    render(<App />)
    await screen.findByText('Auto run · 14:15')
    expect(await screen.findByText('Alert sent · priority 4')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(5000)) // a look that hasn't heard of it doesn't take it away
    expect(screen.getByText('Alert sent · priority 4')).toBeInTheDocument()
  })

  it("says why it wasn't delivered when there was no alert to send", async () => {
    const error = "couldn't compose the alert: KeyError('legs')"
    server.state.latest = {
      ...runInfo('auto', localTime(14, 15)),
      finished_at: localTime(14, 16),
      report,
      alert: { sent: false, priority: null, title: null, error },
    }
    stub()
    render(<App />)
    expect(await screen.findByText(`Alert not delivered: ${error}`)).toHaveClass('warn')
  })

  it("is not carried over to a newer run's report", async () => {
    server.state.latest = { ...runInfo('auto', localTime(14, 15)), finished_at: localTime(14, 16), report, alert: alertSent }
    const own = runInfo('manual', localTime(14, 20))
    stub({
      'POST /api/run': () => {
        server.state.latest = { ...own, finished_at: own.started_at, report }
        return streamed(own)
      },
    })
    render(<App />)
    await screen.findByText('Alert sent · priority 4')
    await userEvent.click(screen.getByRole('button', { name: /^run/i }))
    await screen.findByText('Run · 14:20')
    expect(screen.queryByText('Alert sent · priority 4')).not.toBeInTheDocument()
  })
})
