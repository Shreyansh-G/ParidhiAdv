// Civic Impact Index — spatial accessibility statistics.
//
// For every project we compute:
//   1. popServed — gravity model: Σ over districts of population × Gaussian
//      distance decay  exp(−(d/d₀)²), d₀ = 5 km. "How many residents are in
//      realistic reach of this facility?"
//   2. A 2SFCA-style competition step: divide by the decay-weighted count of
//      same-category facilities in the same catchment. A hospital serving
//      500k people *alone* matters more than one among twenty.
//   3. Impact Index 0–100 — log-compressed, min–max normalized within its
//      category, scaled by project status (an operational facility delivers
//      full impact; one under construction delivers future impact).
//
// computeCivicGaps() inverts the lens: grid the city, score every cell by
// demand (population gravity) vs supply (facility access) and surface the
// most underserved cells — "where should the NEXT hospital go?"
//
// Population data: Census of India 2011, NCT of Delhi district totals
// (9 districts, total ≈ 16.79 M). Centroids are approximate district centers.

import { enhancedProjects, calculateDistance } from '../data/projectsEnhanced'
import type { EnhancedProject } from '../data/projectsEnhanced'

interface District {
  name: string
  population: number
  lat: number
  lng: number
}

// Census 2011 district populations, NCT of Delhi
const DELHI_DISTRICTS: District[] = [
  { name: 'North West', population: 3_656_539, lat: 28.74, lng: 77.06 },
  { name: 'North', population: 887_978, lat: 28.72, lng: 77.19 },
  { name: 'North East', population: 2_241_624, lat: 28.71, lng: 77.27 },
  { name: 'East', population: 1_709_346, lat: 28.63, lng: 77.3 },
  { name: 'New Delhi', population: 142_004, lat: 28.6, lng: 77.21 },
  { name: 'Central', population: 582_320, lat: 28.66, lng: 77.22 },
  { name: 'West', population: 2_543_243, lat: 28.65, lng: 77.06 },
  { name: 'South West', population: 2_292_958, lat: 28.55, lng: 77.03 },
  { name: 'South', population: 2_731_929, lat: 28.51, lng: 77.22 },
]

const D0_KM = 5 // catchment scale: decay ≈ 0.37 at 5 km, ≈ 0.02 at 10 km
const STATUS_MULTIPLIER: Record<EnhancedProject['status'], number> = {
  handovered: 1.0,
  completed: 0.9,
  ongoing: 0.6,
}

function gaussianDecay(distanceKm: number, d0 = D0_KM): number {
  const x = distanceKm / d0
  return Math.exp(-x * x)
}

/** Gravity-model population within realistic reach of a point. */
export function populationInReach(lat: number, lng: number): number {
  let served = 0
  for (const district of DELHI_DISTRICTS) {
    served += district.population * gaussianDecay(calculateDistance(lat, lng, district.lat, district.lng))
  }
  return served
}

export interface ProjectImpact {
  /** 0–100, comparable within a category */
  index: number
  /** gravity-weighted residents in reach */
  popServed: number
  /** decay-weighted same-category competition (1 = alone in its catchment) */
  competition: number
}

let cache: Map<string, ProjectImpact> | null = null

function computeAll(): Map<string, ProjectImpact> {
  const raw = new Map<string, { ratio: number; popServed: number; competition: number }>()

  for (const project of enhancedProjects) {
    const popServed = populationInReach(project.lat, project.lng)

    // 2SFCA competition: decay-weighted supply of the same category nearby
    let competition = 0
    for (const other of enhancedProjects) {
      if (other.category !== project.category) continue
      competition += gaussianDecay(
        calculateDistance(project.lat, project.lng, other.lat, other.lng),
      )
    }

    raw.set(project.id, { ratio: popServed / Math.max(1, competition), popServed, competition })
  }

  // Log-compress + min–max normalize within each category → 0–100
  const result = new Map<string, ProjectImpact>()
  const byCategory = new Map<string, string[]>()
  for (const project of enhancedProjects) {
    const list = byCategory.get(project.category)
    if (list) list.push(project.id)
    else byCategory.set(project.category, [project.id])
  }

  for (const ids of byCategory.values()) {
    const logs = ids.map((id) => Math.log1p(raw.get(id)!.ratio))
    const min = Math.min(...logs)
    const max = Math.max(...logs)
    const span = max - min

    ids.forEach((id, i) => {
      const project = enhancedProjects.find((p) => p.id === id)!
      const normalized = span > 0 ? (logs[i] - min) / span : 0.5
      const { popServed, competition } = raw.get(id)!
      result.set(id, {
        index: Math.max(1, Math.round(normalized * 100 * STATUS_MULTIPLIER[project.status])),
        popServed: Math.round(popServed),
        competition: Number(competition.toFixed(2)),
      })
    })
  }

  return result
}

/** Impact metrics for one project (whole dataset computed once, memoized). */
export function getProjectImpact(projectId: string): ProjectImpact | null {
  if (!cache) cache = computeAll()
  return cache.get(projectId) ?? null
}

// ---------------------------------------------------------------------------
// Civic gaps — underserved-area detection
// ---------------------------------------------------------------------------

export interface GapCell {
  latMin: number
  latMax: number
  lngMin: number
  lngMax: number
  /** higher = more underserved (demand high, supply low) */
  gapScore: number
}

const GRID_DEG = 0.02 // ≈ 2.2 km cells
const BBOX = { south: 28.4, west: 76.85, north: 28.9, east: 77.4 }

/** Is this point inside the Delhi census table's coverage? */
export function isInDelhi(lat: number, lng: number): boolean {
  return lat >= BBOX.south && lat <= BBOX.north && lng >= BBOX.west && lng <= BBOX.east
}

/** A place where people live: Delhi census district, or an OSM settlement. */
export interface DemandPoint {
  population: number
  lat: number
  lng: number
}

/**
 * Grid an area and score demand ÷ supply per cell for one category — works
 * ANYWHERE, given demand points (Delhi census districts, or OSM settlements
 * from populationService) and the facilities actually known in that area.
 *
 * Returns a HEATMAP, not just the worst blob: every inhabited cell in view,
 * each carrying a 0–1 `gapScore`. Showing only the global worst cluster meant
 * the overlay drew a single red patch in a far corner while the area around
 * the user — which they can actually judge — stayed blank.
 */
export function computeGapsAround(
  center: { lat: number; lng: number },
  demandPoints: DemandPoint[],
  facilities: EnhancedProject[],
  // maxCells is a render guard only — it must be high enough to keep EVERY
  // inhabited cell in view. Capping by score used to delete the well-served
  // cells, which are precisely the ones around the user, leaving their own
  // area blank and the overlay looking broken.
  { spanKm = 18, gridDeg = GRID_DEG, maxCells = 400 }: {
    spanKm?: number
    gridDeg?: number
    maxCells?: number
  } = {},
): GapCell[] {
  if (demandPoints.length === 0) return []

  const demandAt = (lat: number, lng: number): number => {
    let served = 0
    for (const p of demandPoints) {
      served += p.population * gaussianDecay(calculateDistance(lat, lng, p.lat, p.lng))
    }
    return served
  }

  // A local bbox around the map center (≈ spanKm on each side)
  const dLat = spanKm / 111
  const dLng = spanKm / (111 * Math.cos((center.lat * Math.PI) / 180) || 1)
  const box = {
    south: center.lat - dLat,
    north: center.lat + dLat,
    west: center.lng - dLng,
    east: center.lng + dLng,
  }

  // Single pass: demand + supply per cell (the old two-pass version computed
  // the gravity model twice over every settlement).
  interface Raw {
    latMin: number
    lngMin: number
    demand: number
    supply: number
  }
  const raw: Raw[] = []
  let peakDemand = 0

  for (let lat = box.south; lat < box.north; lat += gridDeg) {
    for (let lng = box.west; lng < box.east; lng += gridDeg) {
      const cLat = lat + gridDeg / 2
      const cLng = lng + gridDeg / 2

      const demand = demandAt(cLat, cLng)
      if (demand > peakDemand) peakDemand = demand

      let supply = 0
      for (const facility of facilities) {
        supply += gaussianDecay(calculateDistance(cLat, cLng, facility.lat, facility.lng), 3)
      }
      raw.push({ latMin: lat, lngMin: lng, demand, supply })
    }
  }
  if (peakDemand <= 0) return []

  // Keep inhabited cells only: below ~6% of the local peak is empty fringe.
  const inhabited = raw.filter((c) => c.demand >= peakDemand * 0.06)
  if (inhabited.length === 0) return []

  // Raw need = normalized demand ÷ facility access. Then rescale to 0–1 over
  // what is actually on screen, so the shading always spans light → dark.
  const scored = inhabited.map((c) => ({
    ...c,
    need: (c.demand / peakDemand) / (0.15 + c.supply),
  }))
  const maxNeed = Math.max(...scored.map((c) => c.need))
  const minNeed = Math.min(...scored.map((c) => c.need))
  const span = maxNeed - minNeed || 1

  return scored
    .map((c) => ({
      latMin: c.latMin,
      latMax: c.latMin + gridDeg,
      lngMin: c.lngMin,
      lngMax: c.lngMin + gridDeg,
      gapScore: (c.need - minNeed) / span, // 0 = best served, 1 = worst
    }))
    .sort((a, b) => b.gapScore - a.gapScore)
    .slice(0, maxCells)
}

/** Delhi census districts as demand points (best available data inside Delhi). */
export function delhiDemandPoints(): DemandPoint[] {
  return DELHI_DISTRICTS.map((d) => ({ population: d.population, lat: d.lat, lng: d.lng }))
}

/**
 * Delhi-only convenience wrapper (bundled census data, bundled projects).
 * Prefer computeGapsAround for anywhere else.
 */
export function computeCivicGaps(category: EnhancedProject['category']): GapCell[] {
  return computeGapsAround(
    { lat: 28.65, lng: 77.12 },
    delhiDemandPoints(),
    enhancedProjects.filter((p) => p.category === category),
    { spanKm: 28 },
  )
}
