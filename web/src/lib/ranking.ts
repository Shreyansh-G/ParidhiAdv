// Feed-ranking mathematics.
//
// Naive score (upvotes − downvotes) systematically overranks old posts with
// many total votes and underranks young posts with few-but-positive votes.
// We fix both classical problems:
//
//  1. Wilson score lower bound (95% CI) — "given the votes seen so far, what
//     upvote *proportion* can we be statistically confident of?" A 4/0 post
//     beats a 40/30 post, as it should. Spam-resistant: a burst of downvotes
//     drags the bound down hard.
//  2. Exponential time decay — relevance halves every 24 h, so the feed stays
//     fresh without ever hard-cutting old highly-voted posts.

// Structural type — works with both CommunityPost and page-local Post shapes.
export interface RankablePost {
  upvotes?: number
  downvotes?: number
  reports?: number
  createdAt?: { toDate?: () => Date; toMillis?: () => number } | null
}

const Z = 1.959964 // z-score for a 95% two-sided confidence interval
const HALF_LIFE_HOURS = 24
const DECAY = Math.LN2 / HALF_LIFE_HOURS
const REPORT_PENALTY = 0.08 // each report knocks ~8% off the final score

/**
 * Lower bound of the Wilson score confidence interval for the true upvote
 * proportion. Returns 0..1; 0 when there are no votes yet.
 */
export function wilsonLowerBound(upvotes: number, downvotes: number): number {
  const n = upvotes + downvotes
  if (n === 0) return 0
  const phat = upvotes / n
  const z2 = Z * Z
  const denominator = 1 + z2 / n
  const centre = phat + z2 / (2 * n)
  const margin = Z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)
  return Math.max(0, (centre - margin) / denominator)
}

/** Age of a post in hours (0 when the timestamp is missing/pending). */
function ageHours(post: RankablePost): number {
  const created = post.createdAt?.toDate?.()
  if (!created) return 0
  return Math.max(0, (Date.now() - created.getTime()) / 3_600_000)
}

/**
 * "Hot" score: statistically-confident quality × exponential freshness decay,
 * minus a multiplicative penalty per report. A small prior (+1 implicit
 * upvote) keeps brand-new zero-vote posts visible instead of pinned at 0.
 */
export function hotScore(post: RankablePost): number {
  const quality = wilsonLowerBound((post.upvotes ?? 0) + 1, post.downvotes ?? 0)
  const freshness = Math.exp(-DECAY * ageHours(post))
  const reportFactor = Math.max(0, 1 - REPORT_PENALTY * (post.reports ?? 0))
  return quality * freshness * reportFactor
}

export type FeedOrder = 'hot' | 'new'

/** Sort a post list (non-mutating) by the requested feed order. */
export function sortPosts<T extends RankablePost>(posts: T[], order: FeedOrder): T[] {
  const copy = [...posts]
  if (order === 'new') {
    copy.sort(
      (a, b) => (b.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER) - (a.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER),
    )
  } else {
    copy.sort((a, b) => hotScore(b) - hotScore(a))
  }
  return copy
}
