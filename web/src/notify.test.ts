import { describe, expect, it } from 'vitest'
import { runNotice } from './notify'
import { report } from './test/fixtures'

describe('runNotice', () => {
  it('announces a fresh run with its slip count and best slip', () => {
    expect(runNotice({ ok: true, report })).toEqual({
      kind: 'finished',
      title: 'Run finished',
      body: '2 slips · best +12.3% EV (Power 2)',
    })
  })

  it('picks the best slip by EV, whatever the order', () => {
    const slips = [
      { ...report.slips[1], type: 'flex' as const, size: 5, ev_pct: 0.082 },
      { ...report.slips[0], ev_pct: -0.01 },
    ]
    expect(runNotice({ ok: true, report: { ...report, slips } })?.body).toBe('2 slips · best +8.2% EV (Flex 5)')
  })

  it('counts one slip in the singular', () => {
    expect(runNotice({ ok: true, report: { ...report, slips: [report.slips[1]] } })?.body).toBe(
      '1 slip · best −4.0% EV (Flex 2)',
    )
  })

  it('says so when a fresh run found no slips', () => {
    expect(runNotice({ ok: true, report: { ...report, slips: [] } })?.body).toBe('No slips · 2 legs priced')
  })

  it('stays quiet for a cached run', () => {
    expect(runNotice({ ok: true, report: { ...report, live_requests: 0 } })).toBeNull()
  })

  it('announces any failed run with the reason', () => {
    expect(runNotice({ ok: false, error: 'engine exploded' })).toEqual({
      kind: 'failed',
      title: 'Run failed',
      body: 'engine exploded',
    })
  })
})
