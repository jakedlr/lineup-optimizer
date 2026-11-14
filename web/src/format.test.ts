import { describe, expect, it } from 'vitest'
import { elapsed, money, sentence, signOf, signedMoney, signedPct } from './format'

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
