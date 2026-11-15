import { describe, expect, it } from 'vitest'
import { dayClock, elapsed, money, sentence, signOf, signedMoney, signedPct } from './format'

describe('money', () => {
  it('signs an EV with thousands separators and a true minus', () => {
    expect(signedMoney(1234.5)).toBe('+$1,234.50')
    expect(signedMoney(-0.4)).toBe('−$0.40')
  })

  it('never prints a signed zero', () => {
    expect(signedMoney(-0.004)).toBe('$0.00')
    expect(signedMoney(0)).toBe('$0.00')
  })

  it('prints a stake without a sign, and without cents when it has none', () => {
    expect(money(1000)).toBe('$1,000')
    expect(money(7.5)).toBe('$7.50')
  })

  it('takes the sign from the rounded value, so colour matches what is printed', () => {
    expect(signOf(-0.004, 2)).toBe(0)
    expect(signOf(-0.006, 2)).toBe(-1)
    expect(signOf(0.00004, 1, 100)).toBe(0)
    expect(signOf(0.149, 1, 100)).toBe(1)
  })
})

describe('signedPct', () => {
  it('signs a percentage, and leaves a zero unsigned', () => {
    expect(signedPct(0.149)).toBe('+14.9%')
    expect(signedPct(-0.021)).toBe('−2.1%')
    expect(signedPct(-0.0004)).toBe('0.0%')
  })
})

describe('sentence', () => {
  it('capitalises the first letter of an engine message', () => {
    expect(sentence('no sportsbook odds available')).toBe('No sportsbook odds available')
    expect(sentence('')).toBe('')
  })
})

describe('elapsed', () => {
  it('reads minutes and seconds', () => {
    expect(elapsed(7_000)).toBe('0:07')
    expect(elapsed(125_400)).toBe('2:05')
    expect(elapsed(-50)).toBe('0:00')
  })
})

// Sprint 11 review: "Saved 09:12" gave no day, so last week's save read like this morning's.
describe('dayClock', () => {
  const now = new Date(2026, 10, 14, 15, 30) // Saturday 14 Nov 2026, local time
  const at = (d: number, h: number, m: number, month = 10, y = 2026) => new Date(y, month, d, h, m).toISOString()

  it('is the clock time alone today', () => {
    expect(dayClock(at(14, 9, 12), now)).toBe('09:12')
    expect(dayClock(at(14, 0, 1), now)).toBe('00:01')
  })

  it('names the weekday within the last week', () => {
    expect(dayClock(at(13, 23, 59), now)).toBe('Fri 23:59')
    expect(dayClock(at(11, 9, 12), now)).toBe('Wed 09:12')
    expect(dayClock(at(8, 9, 12), now)).toBe('Sun 09:12')
  })

  it('gives the date once older than a week, and the year when not this one', () => {
    expect(dayClock(at(7, 9, 12), now)).toBe('7 Nov 09:12')
    expect(dayClock(at(3, 9, 12), now)).toBe('3 Nov 09:12')
    expect(dayClock(at(30, 18, 5, 11, 2025), now)).toBe('30 Dec 2025 18:05')
  })

  it('gives the date for a time ahead of this clock on another day', () => {
    expect(dayClock(at(15, 9, 12), now)).toBe('15 Nov 09:12')
  })
})
