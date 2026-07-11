// Deep Scan client — calls the LangGraph discovery pipeline
// (discoverProjectsNear), which crawls OpenStreetMap AND local news, geocodes
// what it reads, and returns validated projects with provenance.
//
// The server already caches per ~500 m cell for 24 h ("the 500 m rule"), so
// repeat scans of the same area cost nothing. We keep a small session-level
// cache too, purely to avoid a redundant round-trip.

import { httpsCallable } from 'firebase/functions'
import { firebaseFunctions } from './firebase'
import type { EnhancedProject } from '../data/projectsEnhanced'

export interface DiscoveredProject extends EnhancedProject {
  source: 'osm' | 'news'
  sourceUrl?: string
}

export interface DeepScanResult {
  projects: DiscoveredProject[]
  locality: string
  cached: boolean
  sources: { osm: number; news: number }
}

const sessionCache = new Map<string, DeepScanResult>()

/** ~500 m key, mirroring the server's grid so both layers agree. */
function scanKey(lat: number, lng: number): string {
  return `${Math.round(lat / 0.005)}_${Math.round(lng / 0.005)}`
}

export async function deepScan(
  lat: number,
  lng: number,
  radiusKm = 5,
): Promise<DeepScanResult | null> {
  if (!firebaseFunctions) return null

  const key = scanKey(lat, lng)
  const hit = sessionCache.get(key)
  if (hit) return hit

  try {
    const fn = httpsCallable<
      { lat: number; lng: number; radiusKm: number },
      DeepScanResult
    >(firebaseFunctions, 'discoverProjectsNear', { timeout: 120_000 })

    const result = await fn({ lat, lng, radiusKm })
    const data = result.data
    if (!data?.projects) return null
    sessionCache.set(key, data)
    return data
  } catch (error) {
    console.warn('Deep scan unavailable', error)
    return null
  }
}

/** News-discovered projects get a badge and a source link in the UI. */
export function isNewsProject(project: { id: string }): boolean {
  return project.id.startsWith('news-')
}
