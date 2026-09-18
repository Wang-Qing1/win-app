import { describe, expect, test } from 'vitest'
import {
  addDays,
  computeStreak,
  eachDayKey,
  endOfLocalDay,
  localDateKey,
  localDateKeyOf,
  startOfLocalDay,
  todayKey
} from './datetime'

describe('localDateKey', () => {
  test('formats as YYYY-MM-DD with zero-padded month/day', () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 0, 0))).toBe('2026-01-05')
  })
})

describe('localDateKeyOf', () => {
  test('parses an ISO timestamp into its local date key', () => {
    expect(localDateKeyOf(new Date(2026, 2, 3, 10, 0, 0).toISOString())).toBe('2026-03-03')
  })

  test('returns empty string for an unparseable timestamp', () => {
    expect(localDateKeyOf('not-a-date')).toBe('')
  })
})

describe('todayKey', () => {
  test('defaults to the given date argument, formatted as a local date key', () => {
    expect(todayKey(new Date(2026, 5, 15))).toBe('2026-06-15')
  })
})

describe('addDays', () => {
  test('adds days forward, rolling over month boundaries', () => {
    const result = addDays(new Date(2026, 0, 30), 3)
    expect(localDateKey(result)).toBe('2026-02-02')
  })

  test('subtracts days when given a negative count, rolling over year boundaries', () => {
    const result = addDays(new Date(2026, 0, 1), -1)
    expect(localDateKey(result)).toBe('2025-12-31')
  })

  test('does not mutate the input date', () => {
    const original = new Date(2026, 0, 1)
    addDays(original, 5)
    expect(localDateKey(original)).toBe('2026-01-01')
  })
})

describe('startOfLocalDay / endOfLocalDay', () => {
  test('startOfLocalDay zeroes the time to 00:00:00.000', () => {
    const start = startOfLocalDay(new Date(2026, 3, 10, 15, 30, 45, 500))
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(start.getSeconds()).toBe(0)
    expect(start.getMilliseconds()).toBe(0)
    expect(localDateKey(start)).toBe('2026-04-10')
  })

  test('endOfLocalDay sets the time to 23:59:59.999', () => {
    const end = endOfLocalDay(new Date(2026, 3, 10, 1, 0, 0))
    expect(end.getHours()).toBe(23)
    expect(end.getMinutes()).toBe(59)
    expect(end.getSeconds()).toBe(59)
    expect(end.getMilliseconds()).toBe(999)
    expect(localDateKey(end)).toBe('2026-04-10')
  })
})

describe('eachDayKey', () => {
  test('generates keys strictly after fromExclusive up to and including toInclusive', () => {
    const from = new Date(2026, 0, 1)
    const to = new Date(2026, 0, 4)
    expect(eachDayKey(from, to)).toEqual(['2026-01-02', '2026-01-03', '2026-01-04'])
  })

  test('returns an empty array when from and to are the same day', () => {
    const date = new Date(2026, 0, 1)
    expect(eachDayKey(date, date)).toEqual([])
  })

  test('caps the result at maxDays even if the range is longer', () => {
    const from = new Date(2026, 0, 1)
    const to = new Date(2026, 11, 31)
    expect(eachDayKey(from, to, 5)).toHaveLength(5)
  })
})

describe('computeStreak', () => {
  test('returns 0 when there are no active days', () => {
    expect(computeStreak(new Set())).toBe(0)
  })

  test('counts back from today when today is active', () => {
    const now = new Date(2026, 0, 10)
    const active = new Set(['2026-01-10', '2026-01-09', '2026-01-08'])
    expect(computeStreak(active, now)).toBe(3)
  })

  test('counts back from yesterday when today has no record yet, so opening the app early does not zero the streak', () => {
    const now = new Date(2026, 0, 10)
    const active = new Set(['2026-01-09', '2026-01-08'])
    expect(computeStreak(active, now)).toBe(2)
  })

  test('stops counting at the first gap', () => {
    const now = new Date(2026, 0, 10)
    const active = new Set(['2026-01-10', '2026-01-08'])
    expect(computeStreak(active, now)).toBe(1)
  })

  test('returns 0 when neither today nor yesterday is active', () => {
    const now = new Date(2026, 0, 10)
    const active = new Set(['2026-01-01'])
    expect(computeStreak(active, now)).toBe(0)
  })
})
