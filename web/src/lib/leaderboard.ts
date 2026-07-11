// Real leaderboard — user docs are owner-only readable, so ranking comes from
// the getLeaderboard Cloud Function (which never returns emails or uids).

import { httpsCallable } from 'firebase/functions'
import { firebaseFunctions } from './firebase'

export interface LeaderboardEntry {
  name: string
  explored: number
  xp: number
  level: number
  streak: number
  isYou: boolean
}

const CACHE_KEY = 'paridhi:leaderboard:v1'
const CACHE_TTL_MS = 5 * 60 * 1000

export async function fetchLeaderboard(): Promise<LeaderboardEntry[] | null> {
  if (!firebaseFunctions) return null

  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (raw) {
      const cached = JSON.parse(raw) as { at: number; entries: LeaderboardEntry[] }
      if (Date.now() - cached.at < CACHE_TTL_MS) return cached.entries
    }
  } catch {
    // ignore storage errors
  }

  try {
    const fn = httpsCallable<Record<string, never>, { entries: LeaderboardEntry[] }>(
      firebaseFunctions,
      'getLeaderboard',
    )
    const result = await fn({})
    const entries = result.data?.entries ?? []
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), entries }))
    } catch {
      // ignore storage errors
    }
    return entries
  } catch (error) {
    console.warn('Leaderboard unavailable', error)
    return null
  }
}
