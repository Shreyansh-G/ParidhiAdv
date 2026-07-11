// "Plan my civic walk" — a small travelling-salesman solver.
//
// Given the user's position and nearby unexplored projects, build a short
// walking route: greedy nearest-neighbor construction, then 2-opt local
// search (repeatedly un-cross route segments) until no improvement remains.
// For ≤ ~8 stops this lands at or near the optimal tour in microseconds.

import type { EnhancedProject } from '../data/projectsEnhanced'
import { calculateDistance } from '../data/projectsEnhanced'

const WALKING_SPEED_KMH = 5
const XP_PER_PROJECT = 50

export interface WalkPlan {
  stops: EnhancedProject[]
  /** distance of each leg in km: start→stop1, stop1→stop2, … */
  legsKm: number[]
  totalKm: number
  etaMinutes: number
  potentialXP: number
}

interface PlanOptions {
  maxStops?: number
  /** only consider candidates within this radius of the start */
  searchRadiusKm?: number
  /** drop trailing stops until the tour fits this length */
  maxWalkKm?: number
}

/** Tour length: start → each stop in order (open tour, no return leg). */
function tourLength(start: { lat: number; lng: number }, stops: EnhancedProject[]): number {
  let total = 0
  let prev: { lat: number; lng: number } = start
  for (const stop of stops) {
    total += calculateDistance(prev.lat, prev.lng, stop.lat, stop.lng)
    prev = stop
  }
  return total
}

/** 2-opt: reverse segments while doing so shortens the tour. */
function twoOpt(start: { lat: number; lng: number }, stops: EnhancedProject[]): EnhancedProject[] {
  const route = [...stops]
  let improved = true
  while (improved) {
    improved = false
    for (let i = 0; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const candidate = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)]
        if (tourLength(start, candidate) + 1e-9 < tourLength(start, route)) {
          route.splice(0, route.length, ...candidate)
          improved = true
        }
      }
    }
  }
  return route
}

/**
 * Plan a walking route through nearby unexplored projects.
 * Returns null when there is nothing worth routing to.
 */
/**
 * Weighted random sample without replacement: nearer candidates are more
 * likely, but every call picks a different mix — so replanning gives the
 * user a fresh walk instead of the same deterministic route forever.
 */
function sampleStops(
  pool: Array<{ p: EnhancedProject; d: number }>,
  count: number,
): EnhancedProject[] {
  const items = [...pool]
  const chosen: EnhancedProject[] = []
  while (chosen.length < count && items.length > 0) {
    const weights = items.map(({ d }) => 1 / (0.3 + d))
    const total = weights.reduce((a, b) => a + b, 0)
    let r = Math.random() * total
    let idx = 0
    for (; idx < items.length - 1; idx++) {
      r -= weights[idx]
      if (r <= 0) break
    }
    chosen.push(items.splice(idx, 1)[0].p)
  }
  return chosen
}

export function planCivicWalk(
  start: { lat: number; lng: number },
  candidates: EnhancedProject[],
  isExplored: (id: string) => boolean,
  { maxStops = 6, searchRadiusKm = 3, maxWalkKm = 5 }: PlanOptions = {},
): WalkPlan | null {
  // Candidate pool: unexplored, within the search radius, nearest first
  const pool = candidates
    .filter((p) => !isExplored(p.id))
    .map((p) => ({ p, d: calculateDistance(start.lat, start.lng, p.lat, p.lng) }))
    .filter(({ d }) => d <= searchRadiusKm)
    .sort((a, b) => a.d - b.d)
    .slice(0, maxStops * 3) // keep the solver small

  if (pool.length === 0) return null

  // Greedy nearest-neighbor construction over a randomized stop selection
  const remaining = sampleStops(pool, maxStops)
  const route: EnhancedProject[] = []
  let cursor = { lat: start.lat, lng: start.lng }
  while (route.length < maxStops && remaining.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = calculateDistance(cursor.lat, cursor.lng, remaining[i].lat, remaining[i].lng)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    const next = remaining.splice(bestIdx, 1)[0]
    route.push(next)
    cursor = { lat: next.lat, lng: next.lng }
  }

  // 2-opt improvement, then trim until the tour fits the walking budget
  let optimized = twoOpt(start, route)
  while (optimized.length > 1 && tourLength(start, optimized) > maxWalkKm) {
    optimized = twoOpt(start, optimized.slice(0, -1))
  }

  const legsKm: number[] = []
  let prev = { lat: start.lat, lng: start.lng }
  for (const stop of optimized) {
    legsKm.push(calculateDistance(prev.lat, prev.lng, stop.lat, stop.lng))
    prev = stop
  }
  const totalKm = legsKm.reduce((a, b) => a + b, 0)

  return {
    stops: optimized,
    legsKm,
    totalKm,
    etaMinutes: Math.round((totalKm / WALKING_SPEED_KMH) * 60),
    potentialXP: optimized.length * XP_PER_PROJECT,
  }
}
