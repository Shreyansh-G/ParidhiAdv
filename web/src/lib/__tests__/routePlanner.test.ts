import { describe, it, expect } from 'vitest'
import { planCivicWalk } from '../routePlanner'
import type { EnhancedProject } from '../../data/projectsEnhanced'

const START = { lat: 28.6139, lng: 77.209 }

function project(id: string, lat: number, lng: number): EnhancedProject {
  return {
    id,
    name: `Project ${id}`,
    category: 'Hospitals',
    lat,
    lng,
    description: 'test',
    status: 'handovered',
    type: 'Hospital',
    location: 'Test',
  } as EnhancedProject
}

// A few projects within ~1-2 km of START
const NEARBY = [
  project('a', 28.6180, 77.2100),
  project('b', 28.6100, 77.2150),
  project('c', 28.6200, 77.2050),
  project('d', 28.6150, 77.2200),
]

const none = () => false

describe('planCivicWalk', () => {
  it('returns null when there is nothing unexplored nearby', () => {
    expect(planCivicWalk(START, [], none)).toBeNull()
    // everything already explored
    expect(planCivicWalk(START, NEARBY, () => true)).toBeNull()
  })

  it('ignores projects outside the search radius', () => {
    const faraway = [project('far', 29.5, 78.5)] // ~150 km away
    expect(planCivicWalk(START, faraway, none)).toBeNull()
  })

  it('never includes an explored project as a stop', () => {
    const plan = planCivicWalk(START, NEARBY, (id) => id === 'a')
    expect(plan).not.toBeNull()
    expect(plan!.stops.map((s) => s.id)).not.toContain('a')
  })

  it('respects the walking budget', () => {
    const plan = planCivicWalk(START, NEARBY, none, { maxWalkKm: 5 })
    expect(plan!.totalKm).toBeLessThanOrEqual(5)
  })

  it('respects maxStops', () => {
    const plan = planCivicWalk(START, NEARBY, none, { maxStops: 2 })
    expect(plan!.stops.length).toBeLessThanOrEqual(2)
  })

  it('reports consistent legs, distance, ETA and XP', () => {
    const plan = planCivicWalk(START, NEARBY, none)!
    expect(plan.legsKm.length).toBe(plan.stops.length)
    const summed = plan.legsKm.reduce((a, b) => a + b, 0)
    expect(plan.totalKm).toBeCloseTo(summed, 6)
    expect(plan.potentialXP).toBe(plan.stops.length * 50)
    // 5 km/h walking pace
    expect(plan.etaMinutes).toBe(Math.round((plan.totalKm / 5) * 60))
  })

  it('varies the route between replans (so users are not stuck with one walk)', () => {
    const routes = new Set<string>()
    for (let i = 0; i < 25; i++) {
      const plan = planCivicWalk(START, NEARBY, none, { maxStops: 2 })
      if (plan) routes.add(plan.stops.map((s) => s.id).join('>'))
    }
    expect(routes.size).toBeGreaterThan(1)
  })
})
