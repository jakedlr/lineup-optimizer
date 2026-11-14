import { describe, expect, it } from 'vitest'
import type { AlertsView } from './api'
import {
  alertChanges,
  barsCrossed,
  edgeProblem,
  fromServer,
  legsProblem,
  mergeAlerts,
  randomTopic,
  serverProblem,
  subscribeUrl,
  tierSummary,
  topicProblem,
  zoneChoices,
  zoneLabel,
} from './alertForm'

// Sprint 10: the alert settings as the page edits them (GLOSSARY: Alert, Alert tier, Qualifying leg).

const view = (over: Partial<AlertsView> = {}): AlertsView => ({
  server: 'https://ntfy.sh',
  topic: 'pp-abc',
  token_set: false,
  timezone: 'UTC',
  medium: { enabled: true, edge: 0.5, legs: 3 },
  high: { enabled: true, edge: 1, legs: 3 },
  saved: true,
  updated_at: '2026-11-14T12:00:00+00:00',
  ...over,
})

describe('validation', () => {
  it('takes a topic of 1-64 letters, digits, - and _, or none at all', () => {
    expect(topicProblem('pp-abc_DEF-123')).toBeNull()
    expect(topicProblem('x'.repeat(64))).toBeNull()
    expect(topicProblem('')).toBeNull() // no topic: no alerts
    for (const bad of ['has space', 'a/b', 'x'.repeat(65), 'tópico']) expect(topicProblem(bad)).toMatch(/letters, digits/)
  })

  it('takes an http(s) server URL with nothing after the path', () => {
    for (const ok of ['https://ntfy.sh', 'http://ntfy.lan:8080', 'https://ntfy.home.arpa/push/']) expect(serverProblem(ok)).toBeNull()
    for (const bad of ['', 'ntfy.sh', 'ftp://ntfy.sh', 'https://', 'https://ntfy.sh?x=1', 'https://ntfy .sh', 'https://a#b'])
      expect(serverProblem(bad)).toMatch(/http/)
  })

  it('takes an edge of 0.1-20 points in steps of 0.1, and 1-6 qualifying legs', () => {
    for (const ok of ['0.1', '1', '1.0', '12.3', '20']) expect(edgeProblem(ok)).toBeNull()
    for (const bad of ['', '0', '0.05', '0.15', '20.1', '-1', 'x']) expect(edgeProblem(bad)).not.toBeNull()
    for (const ok of ['1', '3', '6']) expect(legsProblem(ok)).toBeNull()
    for (const bad of ['', '0', '7', '2.5', 'x']) expect(legsProblem(bad)).not.toBeNull()
  })
})

describe('changes to save', () => {
  it('are none when the form is what the server holds', () => {
    expect(alertChanges(fromServer(view()), view())).toBeNull()
  })

  it('are only the valid fields that differ, a tier in part', () => {
    const form = fromServer(view())
    form.topic = 'pp-new'
    form.server = 'not a url'
    form.high = { ...form.high, edge: '1.5', legs: '9' }
    form.medium = { ...form.medium, enabled: false }
    expect(alertChanges(form, view())).toEqual({ topic: 'pp-new', high: { edge: 1.5 }, medium: { enabled: false } })
  })

  it('treat "1.0" and 1 as the same edge', () => {
    const form = fromServer(view())
    form.high = { ...form.high, edge: '1' }
    expect(alertChanges(form, view())).toBeNull()
  })

  it('include a time zone chosen here, but never one that is not a zone, nor none at all', () => {
    const form = fromServer(view())
    form.timezone = 'Asia/Tokyo'
    expect(alertChanges(form, view())).toEqual({ timezone: 'Asia/Tokyo' })
    form.timezone = 'Mars/Olympus'
    expect(alertChanges(form, view())).toBeNull()
    expect(alertChanges(fromServer(view({ timezone: null })), view({ timezone: null }))).toBeNull() // not chosen yet
  })

  it('never include a topic that is not valid yet', () => {
    const form = fromServer(view())
    form.topic = 'half typed/'
    expect(alertChanges(form, view())).toBeNull()
  })
})

describe('taking what the server holds', () => {
  it('shows edges to one decimal', () => {
    expect(fromServer(view()).high.edge).toBe('1.0')
  })

  it("keeps fields edited here, and takes the rest from the server, even within a tier", () => {
    const before = view()
    const form = fromServer(before)
    form.topic = 'pp-mine'
    form.high = { ...form.high, edge: '2.0' }
    const server = view({ topic: 'pp-theirs', server: 'http://ntfy.lan', high: { enabled: false, edge: 1, legs: 4 } })
    const merged = mergeAlerts(form, before, server)
    expect(merged.topic).toBe('pp-mine')
    expect(merged.server).toBe('http://ntfy.lan')
    expect(merged.high).toEqual({ enabled: false, edge: '2.0', legs: '4' })
  })

  it('takes everything from the server when it has nothing to compare with', () => {
    const form = fromServer(view())
    form.topic = 'pp-mine'
    expect(mergeAlerts(form, null, view()).topic).toBe('pp-abc')
  })
})

describe('Random', () => {
  it('makes a hard-to-guess topic from the crypto source', () => {
    const topic = randomTopic()
    expect(topic).toMatch(/^pp-[a-z0-9]{12}$/)
    expect(randomTopic()).not.toBe(topic)
  })

  it('draws every character evenly: bytes that would bias it are thrown back', () => {
    let calls = 0
    const fill = (a: Uint8Array) => {
      calls++
      a.fill(calls === 1 ? 255 : 1) // 252-255 would favour a-d: drawn again
      return a
    }
    expect(randomTopic(fill)).toBe('pp-bbbbbbbbbbbb')
    expect(calls).toBeGreaterThan(1)
  })
})

describe('wording', () => {
  it("says what a tier is met by, and what's off", () => {
    expect(tierSummary({ enabled: true, edge: '1.0', legs: '3' })).toBe('3 or more games with a leg ≥ +1.0%')
    expect(tierSummary({ enabled: true, edge: '2.5', legs: '1' })).toBe('1 game with a leg ≥ +2.5%')
    expect(tierSummary({ enabled: false, edge: '1.0', legs: '3' })).toBe('Off')
    expect(tierSummary({ enabled: true, edge: '', legs: '3' })).toBeNull()
  })

  it("warns only when both tiers are on and medium's bar is above high's", () => {
    const form = fromServer(view())
    expect(barsCrossed(form)).toBe(false)
    form.medium = { ...form.medium, edge: '1.5' }
    expect(barsCrossed(form)).toBe(true)
    expect(barsCrossed({ ...form, high: { ...form.high, enabled: false } })).toBe(false)
    expect(barsCrossed({ ...form, medium: { ...form.medium, edge: '1.0' } })).toBe(false)
  })

  it('links to the topic on its server, to subscribe', () => {
    expect(subscribeUrl('https://ntfy.sh', 'pp-abc')).toBe('https://ntfy.sh/pp-abc')
    expect(subscribeUrl('http://ntfy.lan/', 'pp-abc')).toBe('http://ntfy.lan/pp-abc')
  })
})

describe('Alert time zones', () => {
  const winter = new Date('2026-01-15T12:00:00Z')
  const summer = new Date('2026-07-15T12:00:00Z')

  it('are named by their city and their offset at the time', () => {
    expect(zoneLabel('America/Los_Angeles', winter)).toBe('Los Angeles (GMT-8)')
    expect(zoneLabel('America/Los_Angeles', summer)).toBe('Los Angeles (GMT-7)')
    expect(zoneLabel('Asia/Kolkata', winter)).toBe('Kolkata (GMT+5:30)')
    expect(zoneLabel('America/Argentina/Buenos_Aires', winter)).toBe('Buenos Aires (GMT-3)')
  })

  it("put this browser's first, then the rest by name, keeping the IANA id as the value", () => {
    const choices = zoneChoices('Asia/Tokyo', 'Europe/Oslo', winter)
    expect(choices[0]).toEqual({ value: 'Europe/Oslo', label: 'Oslo (GMT+1)' })
    const rest = choices.slice(1).map((c) => c.label)
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)))
    expect(choices.filter((c) => c.value === 'Europe/Oslo')).toHaveLength(1)
    expect(choices.find((c) => c.value === 'Asia/Tokyo')?.label).toBe('Tokyo (GMT+9)')
  })

  it('keep a chosen zone the browser does not list', () => {
    const choices = zoneChoices('US/Pacific', 'Europe/Oslo', winter)
    expect(choices.map((c) => c.value)).toContain('US/Pacific')
  })
})

describe('Edge in percent', () => {
  it('says its range in percent, as the report reads an edge', () => {
    expect(edgeProblem('30')).toBe('Edge is 0.1% to 20%, in steps of 0.1.')
  })
})
