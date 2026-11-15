import { describe, expect, it } from 'vitest'
import { defaults, NO_PROMOTION, toRun } from './settings'
import { leg, options } from './test/fixtures'

// Sprint 11: why a run can't go names the setting that holds it, so the page can say so where that setting is.

const base = defaults(options)

describe('toRun', () => {
  it('names the setting that holds the run, with the words for it', () => {
    expect(toRun({ ...base, sports: [] }, false)).toEqual({ field: 'sports', text: 'Pick at least one league.' })
    expect(toRun({ ...base, stake: '0' }, false)).toEqual({ field: 'stake', text: 'Stake must be more than $0.' })
    expect(toRun({ ...base, hours: '' }, false)).toEqual({ field: 'hours', text: 'Hours ahead must be more than 0.' })
    expect(toRun(base, false, { ...NO_PROMOTION, kind: 'boost', boost: '1' })).toMatchObject({ field: 'promotion' })
    expect(toRun(base, false, { ...NO_PROMOTION, kind: 'legs' })).toEqual({
      field: 'promotion',
      text: 'Add a promo leg, or set Promos to None.',
    })
    const nba = { ...leg({ sport: 'NBA', player: 'Joel Embiid' }), side: 'over' as const }
    expect(toRun({ ...base, sports: ['NFL'] }, false, { ...NO_PROMOTION, kind: 'legs', legs: [nba] })).toMatchObject({ field: 'promotion' })
  })

  it('gives the request when nothing holds it', () => {
    expect(toRun(base, true)).toMatchObject({ sports: options.defaults.sports, stake: 10, no_cache: true })
  })
})
