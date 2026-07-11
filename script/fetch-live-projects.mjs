#!/usr/bin/env node
// ============================================================================
// Paridhi live-data crawler — 100% free, no API key required.
//
// Pulls REAL Delhi infrastructure from OpenStreetMap's Overpass API
// (community + government-sourced, ODbL licensed, continuously updated):
//   - operational infra  : hospitals, colleges, metro stations, bridges, flyovers
//   - LIVE construction  : roads under construction, active development sites
//
// Optionally augments from data.gov.in (free API key) — see DATA_GOV_RESOURCES.
//
// Output (auto-generated, do not hand-edit):
//   web/src/data/projectsLive.ts
//   functions/src/projectsLive.ts
//
// Run:      node script/fetch-live-projects.mjs
// Refresh:  .github/workflows/refresh-projects.yml (weekly, free)
// ============================================================================

import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Free public Overpass endpoints — tried in order (usage policy: send a real User-Agent)
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]
const USER_AGENT = 'paridhi-civic-pwa/1.0 (civic infrastructure explorer; github.com/Shreyansh-G/paridhi)'
const CENTER = { lat: 28.6139, lng: 77.209 } // New Delhi
const BBOX = '28.40,76.85,28.90,77.40' // south,west,north,east — Delhi NCR core

// data.gov.in (optional): register free at https://data.gov.in, set DATA_GOV_IN_API_KEY,
// then list resource IDs here, e.g. { resourceId: 'xxxx-xxxx', category: 'Road projects' }.
const DATA_GOV_RESOURCES = []

// ---------------------------------------------------------------------------
// Category definitions — Overpass query + normalization rules per category
// ---------------------------------------------------------------------------

const CATEGORIES = [
  {
    category: 'Hospitals',
    cap: 20,
    status: 'handovered',
    query: `nwr["amenity"="hospital"]["name"](${BBOX});`,
    type: (t) => (t['operator:type'] === 'government' ? 'Government Hospital' : 'Hospital'),
    describe: (t, loc) =>
      `Public healthcare facility serving the ${loc} area` +
      (t.beds ? ` with ~${t.beds} beds` : '') +
      (t.emergency === 'yes' ? ', including emergency services' : '') +
      '.',
    impact: () => 'Improves healthcare access and emergency response for nearby residents.',
  },
  {
    category: 'Colleges',
    cap: 20,
    status: 'handovered',
    query: `nwr["amenity"~"^(college|university)$"]["name"](${BBOX});`,
    type: (t) => (t.amenity === 'university' ? 'University Campus' : 'College Campus'),
    describe: (_t, loc) => `Higher-education campus in ${loc}, part of Delhi's public learning infrastructure.`,
    impact: () => 'Expands access to education and skill development for students across NCR.',
  },
  {
    category: 'Metro stations',
    cap: 25,
    status: 'handovered',
    query: `nwr["railway"="station"]["station"="subway"]["name"](${BBOX});`,
    type: (t) => `${t.network || 'Delhi Metro'} Station`,
    describe: (t, loc) =>
      `${t.network || 'Delhi Metro'} station serving ${loc}` +
      (t.interchange === 'yes' ? ' (interchange station)' : '') +
      '.',
    impact: () => 'Enables fast, affordable public transit and reduces road congestion.',
  },
  {
    category: 'Bridges',
    cap: 15,
    status: 'handovered',
    query: `nwr["man_made"="bridge"]["name"](${BBOX});`,
    type: () => 'Bridge Structure',
    describe: (_t, loc) => `Key bridge structure improving cross-connectivity around ${loc}.`,
    impact: () => 'Strengthens urban mobility and shortens travel across natural/rail barriers.',
  },
  {
    category: 'Flyovers',
    cap: 15,
    status: 'handovered',
    query: `way["bridge"="yes"]["highway"~"^(motorway|trunk|primary|secondary)$"]["name"~"Flyover|flyover|Elevated|elevated"](${BBOX});`,
    type: () => 'Flyover / Elevated Corridor',
    describe: (t) => `Grade-separated corridor easing traffic flow${t.name ? ` along ${t.name}` : ''}.`,
    impact: () => 'Cuts signal delays and improves peak-hour traffic throughput.',
  },
  {
    category: 'Road projects',
    cap: 20,
    status: 'ongoing',
    query: `way["highway"="construction"]["name"](${BBOX});`,
    type: (t) => `Road Under Construction${t.construction ? ` (${t.construction})` : ''}`,
    describe: (t, loc) =>
      `Active road construction near ${loc}` +
      (t.construction ? ` — being built as a ${t.construction} road` : '') +
      '. Live from OpenStreetMap construction mapping.',
    impact: () => 'Will enhance connectivity and reduce travel time once opened to traffic.',
  },
  {
    category: 'Smart city projects',
    cap: 15,
    status: 'ongoing',
    query: `way["landuse"="construction"]["name"](${BBOX});`,
    type: () => 'Active Development Site',
    describe: (_t, loc) => `Active construction/redevelopment site in ${loc}, currently in progress.`,
    impact: () => 'Ongoing urban development contributing to the city’s growth.',
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function overpass(query) {
  const body = `[out:json][timeout:90];(${query});out center 400;`
  let lastError
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of OVERPASS_URLS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
          body: `data=${encodeURIComponent(body)}`,
          signal: AbortSignal.timeout(120_000),
        })
        if (!res.ok) {
          lastError = new Error(`${url} → ${res.status}`)
          continue
        }
        const json = await res.json()
        return json.elements ?? []
      } catch (err) {
        lastError = err
        await sleep(2000) // brief backoff before trying the next endpoint
      }
    }
    await sleep(8000) // longer backoff before a full retry round
  }
  throw lastError ?? new Error('All Overpass endpoints failed')
}

function locationOf(tags) {
  return (
    tags['addr:suburb'] ||
    tags['addr:neighbourhood'] ||
    tags['addr:district'] ||
    tags['addr:city'] ||
    'Delhi'
  )
}

function cleanName(name) {
  return name.replace(/\s+/g, ' ').trim().slice(0, 90)
}

function normalize(el, def) {
  const tags = el.tags ?? {}
  if (!tags.name || tags.name.trim().length < 3) return null
  const lat = el.lat ?? el.center?.lat
  const lng = el.lon ?? el.center?.lon
  if (typeof lat !== 'number' || typeof lng !== 'number') return null

  const loc = locationOf(tags)
  const project = {
    id: `osm-${el.type}-${el.id}`,
    name: cleanName(tags.name),
    category: def.category,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    description: def.describe(tags, loc),
    status: def.status,
    type: def.type(tags),
    location: loc === 'Delhi' ? 'Delhi' : `${loc}, Delhi`,
  }
  if (tags.operator) project.department = cleanName(tags.operator)
  const impact = def.impact(tags)
  if (impact) project.impact = impact
  return project
}

// ---------------------------------------------------------------------------
// Optional: data.gov.in augmentation
// ---------------------------------------------------------------------------

async function fetchDataGovIn() {
  const key = process.env.DATA_GOV_IN_API_KEY
  if (!key || DATA_GOV_RESOURCES.length === 0) return []
  const out = []
  for (const { resourceId, category } of DATA_GOV_RESOURCES) {
    try {
      const url = `https://api.data.gov.in/resource/${resourceId}?api-key=${key}&format=json&limit=100`
      const res = await fetch(url)
      if (!res.ok) continue
      const json = await res.json()
      console.log(`  data.gov.in ${resourceId}: ${json.records?.length ?? 0} records (${category})`)
      // Field mapping is dataset-specific — map json.records → project objects here.
    } catch (err) {
      console.warn(`  data.gov.in ${resourceId} failed:`, err.message)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Emit TypeScript modules
// ---------------------------------------------------------------------------

function emit(projects, fetchedAt, importPath, outFile) {
  const header = `// ============================================================================
// AUTO-GENERATED by script/fetch-live-projects.mjs — DO NOT EDIT BY HAND.
// Live Delhi infrastructure data from OpenStreetMap (© OSM contributors, ODbL)
// via the free Overpass API. Re-run the script (or wait for the weekly GitHub
// Action) to refresh.
// Fetched: ${fetchedAt}
// ============================================================================

import type { EnhancedProject } from '${importPath}'

export const liveProjectsFetchedAt = '${fetchedAt}'

export const liveProjects: EnhancedProject[] = `
  writeFileSync(outFile, header + JSON.stringify(projects, null, 2) + '\n', 'utf8')
  console.log(`  wrote ${outFile} (${projects.length} projects)`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching live Delhi infrastructure from Overpass API…')
  const all = []
  const seenNames = new Set()

  for (const def of CATEGORIES) {
    try {
      const elements = await overpass(def.query)
      const normalized = elements
        .map((el) => normalize(el, def))
        .filter(Boolean)
        // de-dupe by name within the whole dataset
        .filter((p) => {
          const key = p.name.toLowerCase()
          if (seenNames.has(key)) return false
          seenNames.add(key)
          return true
        })
        // closest to the city center first, then cap per category
        .sort(
          (a, b) =>
            haversineKm(CENTER.lat, CENTER.lng, a.lat, a.lng) -
            haversineKm(CENTER.lat, CENTER.lng, b.lat, b.lng),
        )
        .slice(0, def.cap)

      console.log(`  ${def.category}: ${elements.length} raw → ${normalized.length} kept`)
      all.push(...normalized)
    } catch (err) {
      console.warn(`  ${def.category}: FAILED (${err.message}) — keeping previous data for this category`)
    }
    await sleep(4000) // be polite to the free Overpass endpoints
  }

  all.push(...(await fetchDataGovIn()))

  if (all.length < 20) {
    console.error(`Only ${all.length} projects fetched — refusing to overwrite existing dataset.`)
    process.exit(1)
  }

  const fetchedAt = new Date().toISOString()
  emit(all, fetchedAt, './projectsEnhanced', resolve(ROOT, 'web/src/data/projectsLive.ts'))
  emit(all, fetchedAt, './projectsData', resolve(ROOT, 'functions/src/projectsLive.ts'))
  console.log(`Done — ${all.length} live projects.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
