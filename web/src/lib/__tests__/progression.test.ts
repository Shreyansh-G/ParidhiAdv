import { describe, it, expect } from 'vitest'
import {
  currentStreak,
  exploredDaySet,
  normalizedCategoryEntropy,
  diversityMultiplier,
  totalXP,
  xpForLevel,
  levelFromXP,
  levelProgress,
} from '../progression'

/** ISO timestamp for N days ago, at midday local (avoids TZ edge flakiness). */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
}

describe('streaks', () => {
  it('is zero with no explorations', () => {
    expect(currentStreak({})).toBe(0)
  })

  it('counts consecutive days ending today', () => {
    const explored = { a: daysAgo(0), b: daysAgo(1), c: daysAgo(2) }
    expect(currentStreak(explored)).toBe(3)
  })

  it('survives a gap of one day (grace period)', () => {
    // Explored yesterday but not yet today — the streak is still alive
    const explored = { a: daysAgo(1), b: daysAgo(2) }
    expect(currentStreak(explored)).toBe(2)
  })

  it('breaks when the last exploration is older than yesterday', () => {
    const explored = { a: daysAgo(3), b: daysAgo(4) }
    expect(currentStreak(explored)).toBe(0)
  })

  it('does not double-count two explorations on the same day', () => {
    const explored = { a: daysAgo(0), b: daysAgo(0), c: daysAgo(1) }
    expect(currentStreak(explored)).toBe(2)
  })

  it('ignores unparseable timestamps', () => {
    expect(exploredDaySet({ a: 'not-a-date', b: daysAgo(0) }).size).toBe(1)
  })
})

describe('diversity (Shannon entropy)', () => {
  it('is zero when everything is one category', () => {
    expect(normalizedCategoryEntropy(['Hospitals', 'Hospitals', 'Hospitals'])).toBe(0)
    expect(diversityMultiplier(['Hospitals'])).toBe(1)
  })

  it('is zero for an empty history', () => {
    expect(normalizedCategoryEntropy([])).toBe(0)
  })

  it('rises as categories spread out', () => {
    const narrow = normalizedCategoryEntropy(['Hospitals', 'Hospitals', 'Colleges'])
    const wide = normalizedCategoryEntropy(['Hospitals', 'Colleges', 'Bridges', 'Flyovers'])
    expect(wide).toBeGreaterThan(narrow)
  })

  it('caps the multiplier at 1.5 for a perfectly even spread', () => {
    const all = [
      'Hospitals',
      'Colleges',
      'Bridges',
      'Metro stations',
      'Road projects',
      'Flyovers',
      'Smart city projects',
    ]
    expect(diversityMultiplier(all)).toBeCloseTo(1.5, 5)
  })
})

describe('XP and levels', () => {
  it('awards base XP with no diversity bonus for a single category', () => {
    expect(totalXP(3, ['Hospitals', 'Hospitals', 'Hospitals'])).toBe(150)
  })

  it('pays more for the same count explored diversely', () => {
    const same = totalXP(4, ['Hospitals', 'Hospitals', 'Hospitals', 'Hospitals'])
    const diverse = totalXP(4, ['Hospitals', 'Colleges', 'Bridges', 'Flyovers'])
    expect(diverse).toBeGreaterThan(same)
  })

  it('level 1 starts at 0 XP and the curve grows', () => {
    expect(xpForLevel(1)).toBe(0)
    expect(xpForLevel(2)).toBe(200)
    expect(xpForLevel(3)).toBeGreaterThan(xpForLevel(2))
    // each gap is wider than the last
    expect(xpForLevel(4) - xpForLevel(3)).toBeGreaterThan(xpForLevel(3) - xpForLevel(2))
  })

  it('levelFromXP inverts xpForLevel', () => {
    for (const level of [1, 2, 3, 5, 8]) {
      expect(levelFromXP(xpForLevel(level))).toBe(level)
      expect(levelFromXP(xpForLevel(level + 1) - 1)).toBe(level)
    }
  })

  it('progress percent stays within 0..100', () => {
    for (const xp of [0, 1, 199, 200, 5000, 100000]) {
      const p = levelProgress(xp)
      expect(p.percent).toBeGreaterThanOrEqual(0)
      expect(p.percent).toBeLessThanOrEqual(100)
      expect(p.xpToNext).toBeGreaterThanOrEqual(0)
    }
  })
})
