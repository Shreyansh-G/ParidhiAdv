import { describe, it, expect } from 'vitest'
import { wilsonLowerBound, hotScore, sortPosts } from '../ranking'

// Mimics a Firestore Timestamp: ranking reads toDate(), sorting reads toMillis()
const hoursAgo = (h: number) => {
  const ms = Date.now() - h * 3600_000
  return { toMillis: () => ms, toDate: () => new Date(ms) }
}

describe('Wilson lower bound', () => {
  it('is zero with no votes', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0)
  })

  it('rewards confidence: 100/0 beats 1/0', () => {
    expect(wilsonLowerBound(100, 0)).toBeGreaterThan(wilsonLowerBound(1, 0))
  })

  it('never exceeds the observed ratio', () => {
    // The whole point of a LOWER bound
    expect(wilsonLowerBound(1, 0)).toBeLessThan(1)
    expect(wilsonLowerBound(10, 10)).toBeLessThan(0.5)
  })

  it('punishes downvotes', () => {
    expect(wilsonLowerBound(10, 0)).toBeGreaterThan(wilsonLowerBound(10, 5))
  })

  it('stays within 0..1 for any input', () => {
    for (const [up, down] of [
      [0, 100],
      [100, 0],
      [7, 3],
      [1, 1],
    ]) {
      const score = wilsonLowerBound(up, down)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })
})

describe('hot score (Wilson × time decay)', () => {
  it('decays with age: same votes, older post ranks lower', () => {
    const fresh = hotScore({ upvotes: 10, downvotes: 0, reports: 0, createdAt: hoursAgo(1) })
    const stale = hotScore({ upvotes: 10, downvotes: 0, reports: 0, createdAt: hoursAgo(48) })
    expect(fresh).toBeGreaterThan(stale)
  })

  it('halves roughly every 24h', () => {
    const now = hotScore({ upvotes: 20, downvotes: 0, reports: 0, createdAt: hoursAgo(0) })
    const day = hotScore({ upvotes: 20, downvotes: 0, reports: 0, createdAt: hoursAgo(24) })
    expect(day / now).toBeCloseTo(0.5, 1)
  })

  it('penalises reported posts', () => {
    const clean = hotScore({ upvotes: 10, downvotes: 0, reports: 0, createdAt: hoursAgo(1) })
    const reported = hotScore({ upvotes: 10, downvotes: 0, reports: 3, createdAt: hoursAgo(1) })
    expect(reported).toBeLessThan(clean)
  })
})

describe('sortPosts', () => {
  const posts = [
    { id: 'old-popular', upvotes: 50, downvotes: 0, reports: 0, createdAt: hoursAgo(72) },
    { id: 'new-quiet', upvotes: 2, downvotes: 0, reports: 0, createdAt: hoursAgo(1) },
    { id: 'new-popular', upvotes: 30, downvotes: 0, reports: 0, createdAt: hoursAgo(2) },
  ]

  it('hot ranks a fresh popular post above a stale popular one', () => {
    const hot = sortPosts(posts, 'hot')
    expect(hot[0].id).toBe('new-popular')
  })

  it('new ranks purely by recency', () => {
    const fresh = sortPosts(posts, 'new')
    expect(fresh[0].id).toBe('new-quiet')
    expect(fresh[2].id).toBe('old-popular')
  })

  it('does not mutate the input array', () => {
    const before = posts.map((p) => p.id)
    sortPosts(posts, 'hot')
    expect(posts.map((p) => p.id)).toEqual(before)
  })
})
