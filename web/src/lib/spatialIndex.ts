// Uniform-grid spatial index for O(1)-ish nearby lookups.
//
// The geofence loop runs every ~5 s; scanning all ~155+ projects each tick is
// O(n) work that grows with the live dataset. A grid hash at ~1.1 km cells
// (0.01°) means a radius query only touches the 3×3 neighborhood around the
// query point — constant time regardless of dataset size.

import type { EnhancedProject } from '../data/projectsEnhanced'
import { calculateDistance } from '../data/projectsEnhanced'

const CELL_DEG = 0.01 // ≈1.11 km N–S; ≈0.98 km E–W at Delhi's latitude

export interface SpatialIndex {
  queryNearby: (lat: number, lng: number, radiusKm: number) => EnhancedProject[]
  size: number
}

function cellKey(lat: number, lng: number): string {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`
}

export function buildSpatialIndex(projects: EnhancedProject[]): SpatialIndex {
  const grid = new Map<string, EnhancedProject[]>()
  for (const project of projects) {
    const key = cellKey(project.lat, project.lng)
    const bucket = grid.get(key)
    if (bucket) bucket.push(project)
    else grid.set(key, [project])
  }

  return {
    size: projects.length,
    queryNearby(lat: number, lng: number, radiusKm: number): EnhancedProject[] {
      // how many cells the radius spans (ceil so the ring fully covers it)
      const span = Math.max(1, Math.ceil(radiusKm / (CELL_DEG * 111)))
      const baseLat = Math.floor(lat / CELL_DEG)
      const baseLng = Math.floor(lng / CELL_DEG)

      const results: EnhancedProject[] = []
      for (let dLat = -span; dLat <= span; dLat++) {
        for (let dLng = -span; dLng <= span; dLng++) {
          const bucket = grid.get(`${baseLat + dLat}:${baseLng + dLng}`)
          if (!bucket) continue
          for (const project of bucket) {
            if (calculateDistance(lat, lng, project.lat, project.lng) <= radiusKm) {
              results.push(project)
            }
          }
        }
      }
      return results
    },
  }
}
