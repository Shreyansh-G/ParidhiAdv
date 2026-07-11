// Progression mathematics: real streaks, a geometric XP curve, and a
// Shannon-entropy diversity bonus.
//
// Replaces the old placeholders (XP = count × 50, level every 200 XP, and a
// literally random "streak").

const BASE_XP_PER_PROJECT = 50
const LEVEL_BASE = 200 // XP gap between level 1 → 2
const LEVEL_GROWTH = 1.35 // each level gap is 35% wider than the previous
const TOTAL_CATEGORIES = 7 // app-wide category count (max entropy = log2(7))
const MAX_DIVERSITY_BONUS = 0.5 // up to +50% XP for perfectly diverse explorers

// ---------------------------------------------------------------------------
// Streak & calendar (from real exploration timestamps)
// ---------------------------------------------------------------------------

/** Local calendar day key, e.g. "2026-07-10". */
function dayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Set of local days ("YYYY-MM-DD") on which at least one project was explored. */
export function exploredDaySet(exploredAt: Record<string, string>): Set<string> {
  const days = new Set<string>()
  for (const iso of Object.values(exploredAt)) {
    const date = new Date(iso)
    if (!Number.isNaN(date.getTime())) days.add(dayKey(date))
  }
  return days
}

/**
 * Current consecutive-day streak. Counts backwards from today; a streak is
 * still "alive" if the last exploration was yesterday (grace so it doesn't
 * reset before the user had a chance to explore today).
 */
export function currentStreak(exploredAt: Record<string, string>): number {
  const days = exploredDaySet(exploredAt)
  if (days.size === 0) return 0

  const cursor = new Date()
  // Streak anchor: today if explored today, else yesterday (grace), else 0
  if (!days.has(dayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1)
    if (!days.has(dayKey(cursor))) return 0
  }

  let streak = 0
  while (days.has(dayKey(cursor))) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

// ---------------------------------------------------------------------------
// Diversity bonus (Shannon entropy over explored categories)
// ---------------------------------------------------------------------------

/**
 * Shannon entropy H = −Σ p·log2(p) of the explored-category distribution,
 * normalized by the maximum possible (log2 of the total category count).
 * 0 = everything in one category, 1 = perfectly even across all 7.
 */
export function normalizedCategoryEntropy(categories: string[]): number {
  if (categories.length === 0) return 0
  const counts = new Map<string, number>()
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1)

  const n = categories.length
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / n
    entropy -= p * Math.log2(p)
  }
  return Math.min(1, entropy / Math.log2(TOTAL_CATEGORIES))
}

/** XP multiplier: 1.0 (single-category) → 1.5 (perfectly diverse). */
export function diversityMultiplier(categories: string[]): number {
  return 1 + MAX_DIVERSITY_BONUS * normalizedCategoryEntropy(categories)
}

// ---------------------------------------------------------------------------
// XP & level curve
// ---------------------------------------------------------------------------

/** Total XP: 50 per project, scaled by the diversity multiplier. */
export function totalXP(exploredCount: number, categories: string[]): number {
  return Math.round(exploredCount * BASE_XP_PER_PROJECT * diversityMultiplier(categories))
}

/**
 * Cumulative XP required to *reach* level n (level 1 = 0 XP).
 * Geometric series: 200·(1.35^(n−1) − 1)/0.35 — early levels come fast,
 * later ones demand real dedication.
 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0
  return Math.round((LEVEL_BASE * (Math.pow(LEVEL_GROWTH, level - 1) - 1)) / (LEVEL_GROWTH - 1))
}

/** Level from total XP (inverse of xpForLevel). */
export function levelFromXP(xp: number): number {
  let level = 1
  while (xpForLevel(level + 1) <= xp) level++
  return level
}

export interface LevelProgress {
  level: number
  xp: number
  levelFloorXP: number
  nextLevelXP: number
  /** 0..100 progress within the current level */
  percent: number
  xpToNext: number
}

export function levelProgress(xp: number): LevelProgress {
  const level = levelFromXP(xp)
  const levelFloorXP = xpForLevel(level)
  const nextLevelXP = xpForLevel(level + 1)
  const span = nextLevelXP - levelFloorXP
  const percent = span > 0 ? Math.min(100, ((xp - levelFloorXP) / span) * 100) : 100
  return { level, xp, levelFloorXP, nextLevelXP, percent, xpToNext: Math.max(0, nextLevelXP - xp) }
}
