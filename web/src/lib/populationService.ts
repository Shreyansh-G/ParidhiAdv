// Population demand points — free, works anywhere in the world.
//
// The Civic Gaps ("Needs") overlay needs to know WHERE PEOPLE LIVE. Delhi has
// census district totals bundled in civicImpact.ts, but outside Delhi we have
// no such table — so we read population from OpenStreetMap itself: `place`
// nodes (city/town/village/suburb) frequently carry a `population` tag, and
// where they don't, the place type is a reasonable proxy.
//
// One Overpass call per ~11 km cell, cached 7 days.

import { BoundedCache } from './storage'

export interface PopulationPoint {
  name: string
  population: number
  lat: number
  lng: number
}

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]

// Typical Indian settlement sizes, used when OSM has no population tag.
const PLACE_DEFAULTS: Record<string, number> = {
  city: 300_000,
  borough: 150_000,
  suburb: 50_000,
  town: 40_000,
  quarter: 20_000,
  neighbourhood: 10_000,
  village: 5_000,
  hamlet: 1_000,
  isolated_dwelling: 200,
}

const placesCache = new BoundedCache<PopulationPoint[]>({
  prefix: 'paridhi:places:v1:',
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  maxEntries: 20,
})

interface PlaceElement {
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

/**
 * Settlements with population within `radiusKm` of a point. Returns [] when
 * OpenStreetMap has nothing mapped (genuinely remote) or the API is down —
 * callers must treat an empty result as "cannot compute", not "nobody lives here".
 */
export async function fetchPopulationPoints(
  lat: number,
  lng: number,
  radiusKm = 25,
): Promise<PopulationPoint[]> {
  const key = `${lat.toFixed(1)},${lng.toFixed(1)},${radiusKm}`
  const cached = placesCache.get(key)
  if (cached) return cached

  const around = `(around:${Math.round(radiusKm * 1000)},${lat},${lng})`
  // Exact matches only — regex can't use Overpass's tag index (see overpassLive).
  // The output cap must be generous: a rural district can hold 500+ hamlets, and
  // truncating them silently biases the whole demand model (measured: a 300 cap
  // was being hit around Sonbhadra, so population came from an arbitrary subset).
  const query = `[out:json][timeout:50];(
node["place"="city"]${around};
node["place"="borough"]${around};
node["place"="suburb"]${around};
node["place"="town"]${around};
node["place"="quarter"]${around};
node["place"="neighbourhood"]${around};
node["place"="village"]${around};
node["place"="hamlet"]${around};
);out 1200;`

  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) continue
      const json = (await res.json()) as { elements?: PlaceElement[]; remark?: string }
      if (json.remark && (json.elements?.length ?? 0) === 0) continue // disguised timeout

      const points: PopulationPoint[] = []
      for (const el of json.elements ?? []) {
        const pLat = el.lat ?? el.center?.lat
        const pLng = el.lon ?? el.center?.lon
        const tags = el.tags ?? {}
        if (typeof pLat !== 'number' || typeof pLng !== 'number' || !tags.place) continue

        const tagged = Number.parseInt(tags.population ?? '', 10)
        const population =
          Number.isFinite(tagged) && tagged > 0 ? tagged : (PLACE_DEFAULTS[tags.place] ?? 0)
        if (population <= 0) continue

        points.push({
          name: tags.name ?? tags.place,
          population,
          lat: pLat,
          lng: pLng,
        })
      }

      if (points.length > 0) placesCache.set(key, points) // never cache emptiness
      return points
    } catch {
      // try the next mirror
    }
  }
  return []
}
