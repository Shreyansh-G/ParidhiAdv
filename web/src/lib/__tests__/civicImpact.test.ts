import { describe, it, expect } from 'vitest'
import { computeGapsAround, isInDelhi, type DemandPoint } from '../civicImpact'
import type { EnhancedProject } from '../../data/projectsEnhanced'

const CENTER = { lat: 24.6974, lng: 83.0653 } // Sonbhadra, UP — deliberately NOT Delhi

function hospital(id: string, lat: number, lng: number): EnhancedProject {
  return {
    id,
    name: id,
    category: 'Hospitals',
    lat,
    lng,
    description: '',
    status: 'handovered',
    type: 'Hospital',
    location: '',
  } as EnhancedProject
}

// Two population clusters: one right next to the center, one 15 km north
const DEMAND: DemandPoint[] = [
  { population: 40_000, lat: 24.70, lng: 83.06 }, // near the user
  { population: 40_000, lat: 24.83, lng: 83.06 }, // ~15 km north
]

describe('isInDelhi', () => {
  it('recognises Delhi and rejects elsewhere', () => {
    expect(isInDelhi(28.6139, 77.209)).toBe(true)
    expect(isInDelhi(24.6974, 83.0653)).toBe(false) // Sonbhadra
  })
})

describe('computeGapsAround', () => {
  it('returns nothing when there is no population data (cannot compute need)', () => {
    expect(computeGapsAround(CENTER, [], [])).toEqual([])
  })

  it('works outside Delhi (the whole point of the OSM population path)', () => {
    const cells = computeGapsAround(CENTER, DEMAND, [])
    expect(cells.length).toBeGreaterThan(0)
  })

  it('scores the area WITHOUT facilities as needier than the area with them', () => {
    // Hospitals only next to the user; the northern cluster has none
    const facilities = [hospital('h1', 24.70, 83.06), hospital('h2', 24.705, 83.065)]
    const cells = computeGapsAround(CENTER, DEMAND, facilities)

    const near = (c: (typeof cells)[number], lat: number) =>
      Math.abs((c.latMin + c.latMax) / 2 - lat) < 0.02

    const worst = cells[0] // sorted worst-first
    expect(near(worst, 24.83)).toBe(true) // the underserved northern cluster

    const bestServed = cells[cells.length - 1]
    expect(bestServed.gapScore).toBeLessThan(worst.gapScore)
  })

  it('normalises gapScore to 0..1 so the colour ramp always spans', () => {
    const cells = computeGapsAround(CENTER, DEMAND, [hospital('h1', 24.70, 83.06)])
    const scores = cells.map((c) => c.gapScore)
    expect(Math.min(...scores)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...scores)).toBeLessThanOrEqual(1)
    expect(Math.max(...scores)).toBeCloseTo(1, 5) // the worst cell anchors the ramp
  })

  it('keeps cells around the user, not only the worst blob far away', () => {
    const cells = computeGapsAround(CENTER, DEMAND, [hospital('h1', 24.70, 83.06)])
    const nearUser = cells.filter(
      (c) =>
        Math.abs((c.latMin + c.latMax) / 2 - CENTER.lat) < 0.05 &&
        Math.abs((c.lngMin + c.lngMax) / 2 - CENTER.lng) < 0.05,
    )
    expect(nearUser.length).toBeGreaterThan(0)
  })

  it('is fast enough for a tap (grid × settlements stays under ~200ms)', () => {
    const manyPlaces: DemandPoint[] = Array.from({ length: 800 }, (_, i) => ({
      population: 1000,
      lat: 24.5 + (i % 40) * 0.01,
      lng: 82.9 + Math.floor(i / 40) * 0.01,
    }))
    const t0 = performance.now()
    computeGapsAround(CENTER, manyPlaces, [])
    expect(performance.now() - t0).toBeLessThan(200)
  })
})
