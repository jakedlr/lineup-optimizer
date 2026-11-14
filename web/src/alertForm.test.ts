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
