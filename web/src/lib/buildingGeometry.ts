// Real building footprints for the 3D viewer.
//
// Projects with `osm-way-*` ids ARE OpenStreetMap ways — we can fetch their
// actual polygon geometry (free, Overpass API) and extrude the real shape of
// the hospital/college/station in three.js. Coordinates are converted to a
// local meter grid centered on the footprint's centroid.

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]

import { footprintCache } from './storage'

export interface Footprint {
  /** polygon in local meters, centered on the centroid */
  points: { x: number; y: number }[]
  /** number of floors from OSM building:levels, if mapped */
  levels: number | null
  /** rough footprint width in meters (for camera framing) */
  extentM: number
}

interface OverpassGeomElement {
  type: string
  id: number
  geometry?: { lat: number; lon: number }[]
  tags?: Record<string, string>
}

/**
 * Fetch the real OSM footprint for a project id like "osm-way-123456".
 * Returns null for non-way projects, unmapped geometry, or network failure —
 * the viewer falls back to a procedural model.
 */
export async function fetchFootprint(projectId: string): Promise<Footprint | null> {
  const match = /^osm-way-(\d+)$/.exec(projectId)
  if (!match) return null
  const wayId = match[1]

  // TTL + LRU eviction + quota recovery handled by ./storage (footprintCache)
  const cached = footprintCache.get(wayId) as Footprint | null
  if (cached) return cached

  const body = `data=${encodeURIComponent(`[out:json][timeout:20];way(${wayId});out geom tags;`)}`
  let footprint: Footprint | null = null

  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      if (!res.ok) continue
      const json = (await res.json()) as { elements?: OverpassGeomElement[] }
      const way = json.elements?.[0]
      const geometry = way?.geometry
      if (!geometry || geometry.length < 3) break

      // Project lat/lng onto a local meter grid (equirectangular around centroid)
      const lat0 = geometry.reduce((s, p) => s + p.lat, 0) / geometry.length
      const lng0 = geometry.reduce((s, p) => s + p.lon, 0) / geometry.length
      const mPerDegLat = 110_540
      const mPerDegLng = 111_320 * Math.cos((lat0 * Math.PI) / 180)

      const points = geometry.map((p) => ({
        x: (p.lon - lng0) * mPerDegLng,
        y: (p.lat - lat0) * mPerDegLat,
      }))

      const xs = points.map((p) => p.x)
      const ys = points.map((p) => p.y)
      const extentM = Math.max(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      )

      const levelsRaw = way?.tags?.['building:levels']
      const levels = levelsRaw ? Number.parseFloat(levelsRaw) || null : null

      footprint = { points, levels, extentM }
      break
    } catch {
      // try the next mirror
    }
  }

  // Only cache real geometry — a failed fetch must not stick for a week.
  if (footprint) footprintCache.set(wayId, footprint)
  return footprint
}
