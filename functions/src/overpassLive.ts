// Server-side live infrastructure lookup — free (OpenStreetMap Overpass API).
// Used by the Civic Assistant agent tool `find_live_projects_near` and by the
// Deep Scan pipeline, so both can find real projects around ANY coordinate.
//
// Two deliberate design rules:
//  1. The Overpass QUERY uses exact tag matches (never regex). That is an index
//     lookup, not comprehension — regex forces a table scan and times out in
//     rural areas (measured: regex → 51s timeout, 0 results; exact → 2.0s, 21
//     results at the same coordinates).
//  2. The CLASSIFICATION (tag → category) is NOT hardcoded if-chains. It goes
//     through ./tagClassifier, which knows the common tags, remembers what the
//     AI taught it, and asks Gemini about anything genuinely new (once, ever).

import type { EnhancedProject } from './projectsData'
import { calculateDistance } from './projectsData'
import { classifyFromSeed, classifyTags, tagSignature, type Classification } from './tagClassifier'

export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
export const USER_AGENT = 'paridhi-civic-pwa/1.0 (civic infrastructure explorer)'
const MAX_RESULTS = 25

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

// Exact matches only (see rule 1 above). The list is broad — including tags no
// rule hardcodes a meaning for (power, water works, waste) — because the
// classifier can now learn whatever it doesn't recognise.
function buildQuery(lat: number, lng: number, radiusM: number): string {
  const a = `(around:${radiusM},${lat},${lng})`
  return `[out:json][timeout:60];(
nwr["amenity"="hospital"]${a};
nwr["amenity"="clinic"]${a};
nwr["amenity"="doctors"]${a};
nwr["amenity"="school"]${a};
nwr["amenity"="college"]${a};
nwr["amenity"="university"]${a};
nwr["amenity"="library"]${a};
nwr["amenity"="bus_station"]${a};
nwr["amenity"="police"]${a};
nwr["amenity"="fire_station"]${a};
nwr["amenity"="marketplace"]${a};
nwr["amenity"="community_centre"]${a};
nwr["amenity"="waste_transfer_station"]${a};
nwr["railway"="station"]${a};
nwr["railway"="halt"]${a};
nwr["power"="substation"]${a};
nwr["man_made"="water_works"]${a};
nwr["man_made"="water_tower"]${a};
way["highway"="construction"]${a};
way["landuse"="construction"]${a};
way["building"="construction"]${a};
way["man_made"="bridge"]${a};
);out center 200;`
}

interface ParsedElement {
  el: OverpassElement
  signature: string
  lat: number
  lng: number
}

/** Pull out the elements we can place on a map, with their tag signature. */
function parse(elements: OverpassElement[]): ParsedElement[] {
  const parsed: ParsedElement[] = []
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat
    const lng = el.lon ?? el.center?.lon
    if (typeof lat !== 'number' || typeof lng !== 'number') continue
    const signature = tagSignature(el.tags ?? {})
    if (!signature) continue
    parsed.push({ el, signature, lat, lng })
  }
  return parsed
}

function toProject(item: ParsedElement, kind: Classification): EnhancedProject {
  const tags = item.el.tags ?? {}
  // Unnamed elements (common for construction) get a readable generated label
  const given = tags.name?.replace(/\s+/g, ' ').trim()
  const name =
    given && given.length >= 3 ? given : `${kind.type} #${String(item.el.id).slice(-4)}`
  const loc = tags['addr:suburb'] || tags['addr:neighbourhood'] || tags['addr:city'] || 'the area'

  const project: EnhancedProject = {
    id: `osm-${item.el.type}-${item.el.id}`,
    name: name.slice(0, 90),
    category: kind.category,
    lat: Number(item.lat.toFixed(6)),
    lng: Number(item.lng.toFixed(6)),
    description: `${kind.type} in ${loc} (live from OpenStreetMap).`,
    status: kind.status,
    type: kind.type,
    location: loc,
  }
  if (tags.operator) project.department = tags.operator.slice(0, 90)
  return project
}

/** One Overpass round-trip at a fixed radius; null = every mirror failed. */
async function queryOverpass(
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<ParsedElement[] | null> {
  const body = `data=${encodeURIComponent(buildQuery(lat, lng, Math.round(radiusKm * 1000)))}`

  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(40_000),
      })
      if (!res.ok) continue
      const json = (await res.json()) as { elements?: OverpassElement[]; remark?: string }
      // 200 + "runtime error/timed out" remark + no elements = mirror failure
      if (json.remark && (json.elements?.length ?? 0) === 0) continue
      return parse(json.elements ?? [])
    } catch {
      // try the next mirror
    }
  }
  return null
}

/**
 * Fetch live infrastructure around a coordinate.
 *
 * Stays as LOCAL as possible: it starts at the requested radius and only
 * widens — gently — when an attempt comes back completely empty, stopping the
 * moment it finds anything. Users want what is around their own locality, not
 * a district-wide dump; the ladder exists only so that a genuinely sparse
 * rural area still surfaces its nearest hospital instead of nothing at all.
 *
 * Pass `geminiApiKey` to enable AI classification of tags nobody hardcoded
 * (learned once, then cached forever). Without it, only the seed tags resolve.
 */
export async function fetchLiveProjectsNear(
  lat: number,
  lng: number,
  radiusKm = 4,
  geminiApiKey?: string,
): Promise<EnhancedProject[]> {
  let found: ParsedElement[] = []

  // Gentle climb: 5 → 8 → 12.5 → 20 km for a 5 km request
  for (const radius of [radiusKm, radiusKm * 1.6, radiusKm * 2.5, radiusKm * 4]) {
    const results = await queryOverpass(lat, lng, Math.min(radius, 25))
    if (results === null) return [] // all mirrors down — widening won't help
    if (results.length > 0) {
      found = results
      break
    }
  }
  if (found.length === 0) return []

  // Classify: seed → learned → AI (one batched call for anything new)
  let lookup: Map<string, Classification | null>
  if (geminiApiKey) {
    lookup = await classifyTags(
      found.map((f) => f.signature),
      geminiApiKey,
    )
  } else {
    lookup = new Map()
    for (const item of found) {
      lookup.set(item.signature, classifyFromSeed(item.el.tags ?? {}))
    }
  }

  const seen = new Set<string>()
  return found
    .map((item) => {
      const kind = lookup.get(item.signature)
      return kind ? toProject(item, kind) : null
    })
    .filter((p): p is EnhancedProject => {
      if (!p) return false
      const key = `${p.name.toLowerCase()}|${p.lat.toFixed(3)},${p.lng.toFixed(3)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort(
      (a, b) =>
        calculateDistance(lat, lng, a.lat, a.lng) - calculateDistance(lat, lng, b.lat, b.lng),
    )
    .slice(0, MAX_RESULTS)
}
