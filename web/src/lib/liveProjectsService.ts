// Live nearby-infrastructure service — 100% free, runs in the browser.
//
// Queries the OpenStreetMap Overpass API (CORS-enabled, no key) around any
// coordinate and normalizes results into the app's EnhancedProject shape.
// Results are cached per ~1 km grid cell in localStorage for 24 h so we stay
// polite to the free endpoints and instant for the user.

import type { EnhancedProject } from '../data/projectsEnhanced'
import type { ProjectCategory } from '../types/projects'
import { calculateDistance } from '../data/projectsEnhanced'
import { scanCache } from './storage'

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]

// TTL, size cap and eviction policy for this cache live in ./storage (scanCache)
const MAX_RESULTS = 40

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

// One combined query per area — a single polite request instead of many.
//
// IMPORTANT: use EXACT tag matches (`=`), never regex (`~`). Regex filters
// cannot use Overpass's tag index — they force a scan and time out in rural
// areas (measured: regex → 51s timeout, 0 results; exact → 2.0s, 21 results
// at the same coordinates). Keep this query index-friendly.
function buildQuery(lat: number, lng: number, radiusM: number): string {
  const a = `(around:${radiusM},${lat},${lng})`
  return `[out:json][timeout:60];(
nwr["amenity"="hospital"]${a};
nwr["amenity"="clinic"]${a};
nwr["amenity"="school"]${a};
nwr["amenity"="college"]${a};
nwr["amenity"="university"]${a};
nwr["amenity"="bus_station"]${a};
nwr["amenity"="police"]${a};
nwr["amenity"="fire_station"]${a};
nwr["railway"="station"]${a};
way["highway"="construction"]${a};
way["landuse"="construction"]${a};
way["building"="construction"]${a};
way["man_made"="bridge"]${a};
);out center 200;`
}

function categorize(tags: Record<string, string>): {
  category: ProjectCategory
  status: EnhancedProject['status']
  type: string
} | null {
  if (tags.highway === 'construction') {
    return {
      category: 'Road projects',
      status: 'ongoing',
      type: `Road Under Construction${tags.construction ? ` (${tags.construction})` : ''}`,
    }
  }
  if (tags.landuse === 'construction' || tags.building === 'construction') {
    return {
      category: 'Smart city projects',
      status: 'ongoing',
      type: tags.building === 'construction' ? 'Building Under Construction' : 'Active Development Site',
    }
  }
  if (tags.railway === 'station') {
    const isMetro = tags.station === 'subway' || tags.station === 'light_rail'
    return {
      category: 'Metro stations',
      status: 'handovered',
      type: `${tags.network || (isMetro ? 'Metro' : 'Railway')} Station`,
    }
  }
  if (tags.amenity === 'bus_station') {
    return { category: 'Metro stations', status: 'handovered', type: 'Bus Terminal' }
  }
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic') {
    return {
      category: 'Hospitals',
      status: 'handovered',
      type: tags.amenity === 'clinic' ? 'Health Clinic' : 'Hospital',
    }
  }
  if (tags.amenity === 'college' || tags.amenity === 'university' || tags.amenity === 'school') {
    return {
      category: 'Colleges',
      status: 'handovered',
      type:
        tags.amenity === 'university'
          ? 'University Campus'
          : tags.amenity === 'school'
            ? 'School Campus'
            : 'College Campus',
    }
  }
  if (tags.amenity === 'police' || tags.amenity === 'fire_station') {
    return {
      category: 'Smart city projects',
      status: 'handovered',
      type: tags.amenity === 'police' ? 'Police Station' : 'Fire Station',
    }
  }
  if (tags.bridge === 'yes' && tags.highway) {
    return { category: 'Flyovers', status: 'handovered', type: 'Flyover / Elevated Corridor' }
  }
  if (tags.man_made === 'bridge') {
    return { category: 'Bridges', status: 'handovered', type: 'Bridge Structure' }
  }
  return null
}

function describe(category: ProjectCategory, tags: Record<string, string>, loc: string): string {
  switch (category) {
    case 'Hospitals':
      return `Public healthcare facility serving the ${loc} area${tags.emergency === 'yes' ? ', including emergency services' : ''}.`
    case 'Colleges':
      return tags.amenity === 'school'
        ? `School campus serving families in ${loc}.`
        : `Higher-education campus in ${loc}.`
    case 'Metro stations':
      return tags.amenity === 'bus_station'
        ? `Bus terminal connecting ${loc} to regional routes.`
        : `${tags.network || 'Transit'} station serving ${loc}${tags.interchange === 'yes' ? ' (interchange station)' : ''}.`
    case 'Bridges':
      return `Key bridge structure improving cross-connectivity around ${loc}.`
    case 'Flyovers':
      return `Grade-separated corridor easing traffic flow${tags.name ? ` along ${tags.name}` : ''}.`
    case 'Road projects':
      return `Active road construction near ${loc}. Live from OpenStreetMap construction mapping.`
    case 'Smart city projects':
      return tags.amenity === 'police' || tags.amenity === 'fire_station'
        ? `Public-safety facility serving the ${loc} area.`
        : `Active construction/redevelopment site in ${loc}, currently in progress.`
    default:
      return `Public infrastructure in ${loc}.`
  }
}

function normalize(el: OverpassElement): EnhancedProject | null {
  const tags = el.tags ?? {}
  const lat = el.lat ?? el.center?.lat
  const lng = el.lon ?? el.center?.lon
  if (typeof lat !== 'number' || typeof lng !== 'number') return null

  const kind = categorize(tags)
  if (!kind) return null

  // Unnamed elements (common for construction in small localities) get a
  // readable generated label; the OSM id suffix keeps each one distinct.
  const givenName = tags.name?.replace(/\s+/g, ' ').trim()
  const name =
    givenName && givenName.length >= 3 ? givenName : `${kind.type} #${String(el.id).slice(-4)}`

  const loc =
    tags['addr:suburb'] ||
    tags['addr:neighbourhood'] ||
    tags['addr:district'] ||
    tags['addr:city'] ||
    'this'

  const project: EnhancedProject = {
    id: `osm-${el.type}-${el.id}`,
    name: name.slice(0, 90),
    category: kind.category,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    description: describe(kind.category, tags, loc),
    status: kind.status,
    type: kind.type,
    location: loc === 'this' ? 'Nearby' : loc,
  }
  if (tags.operator) project.department = tags.operator.slice(0, 90)
  return project
}

function cacheKey(lat: number, lng: number, radiusKm: number): string {
  // ~1.1 km grid cells so small GPS jitter reuses the same cache entry
  return `${lat.toFixed(2)},${lng.toFixed(2)},${radiusKm}`
}

const inFlight = new Map<string, Promise<EnhancedProject[]>>()

/**
 * Fetch live infrastructure around a coordinate (default 4 km radius).
 * Free (Overpass API), cached for 24 h per area, safe to call repeatedly.
 * Returns [] on failure — callers always have the bundled dataset as a base.
 */
export async function fetchProjectsNear(
  lat: number,
  lng: number,
  radiusKm = 4,
): Promise<EnhancedProject[]> {
  const key = cacheKey(lat, lng, radiusKm)

  // TTL + LRU eviction + quota recovery all live in the BoundedCache
  const cached = scanCache.get(key) as EnhancedProject[] | null
  if (cached) return cached

  const pending = inFlight.get(key)
  if (pending) return pending

  /** One round-trip at a fixed radius; null = every mirror failed. */
  const queryAt = async (radius: number): Promise<EnhancedProject[] | null> => {
    const body = `data=${encodeURIComponent(buildQuery(lat, lng, Math.round(radius * 1000)))}`
    for (const url of OVERPASS_URLS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          // A hung mirror must fall through to the next one, not stall the scan
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) continue
        const json = (await res.json()) as { elements?: OverpassElement[]; remark?: string }
        // Overpass can answer 200 with a "runtime error/timed out" remark and
        // zero elements — that's a mirror failure, not an empty area.
        if (json.remark && (json.elements?.length ?? 0) === 0) continue

        const seen = new Set<string>()
        return (json.elements ?? [])
          .map(normalize)
          .filter((p): p is EnhancedProject => {
            if (!p) return false
            // name + coarse location, so distinct same-named places survive
            const nameKey = `${p.name.toLowerCase()}|${p.lat.toFixed(3)},${p.lng.toFixed(3)}`
            if (seen.has(nameKey)) return false
            seen.add(nameKey)
            return true
          })
          .sort(
            (a, b) =>
              calculateDistance(lat, lng, a.lat, a.lng) - calculateDistance(lat, lng, b.lat, b.lng),
          )
          .slice(0, MAX_RESULTS)
      } catch {
        // try the next mirror
      }
    }
    return null
  }

  const request = (async () => {
    // Widen the net in sparse areas — rural India's nearest hospital or
    // station is often 10-20 km away, not 4.
    for (const radius of [radiusKm, radiusKm * 2.5, radiusKm * 5]) {
      const projects = await queryAt(Math.min(radius, 30))
      if (projects === null) {
        console.warn('Live nearby fetch failed on all Overpass mirrors')
        return [] // mirrors down — a wider radius won't help
      }
      if (projects.length > 0) {
        // Never cache emptiness — a flaky mirror must not lock an area
        // "empty" for 24 h; genuinely empty areas just re-query on demand.
        scanCache.set(key, projects)
        return projects
      }
    }
    return []
  })().finally(() => inFlight.delete(key))

  inFlight.set(key, request)
  return request
}

/**
 * Merge live results into a base list, skipping duplicates
 * (same id, same name, or same category within 250 m).
 */
export function mergeUniqueProjects(
  base: EnhancedProject[],
  extra: EnhancedProject[],
): EnhancedProject[] {
  const merged = [...base]
  for (const item of extra) {
    const isDuplicate = base.some(
      (b) =>
        b.id === item.id ||
        b.name.toLowerCase() === item.name.toLowerCase() ||
        (b.category === item.category &&
          calculateDistance(b.lat, b.lng, item.lat, item.lng) < 0.25),
    )
    if (!isDuplicate) merged.push(item)
  }
  return merged
}
