// Tag classifier — turns an OpenStreetMap tag signature (e.g. "amenity=hospital",
// "power=substation") into one of Paridhi's project categories.
//
// Three tiers, cheapest first:
//   1. SEED map      — the common civic tags. Instant, free, deterministic.
//   2. Firestore     — tags the AI has already classified. Instant, free.
//   3. Gemini        — anything NEW, classified once (batched into a single
//                      call) and then written to Firestore forever.
//
// So the system GENERALIZES: it can ingest an OSM tag nobody hardcoded, work
// out what it is, and never pay for that tag again. A deterministic guardrail
// still validates the AI's answer (category must be one of the seven).

import * as admin from 'firebase-admin'
import { logger } from 'firebase-functions'
import { geminiJson } from './gemini'
import type { EnhancedProject, ProjectCategory } from './projectsData'

const CACHE_COLLECTION = 'tagClassifications'

export const CATEGORIES: ProjectCategory[] = [
  'Hospitals',
  'Colleges',
  'Bridges',
  'Metro stations',
  'Road projects',
  'Flyovers',
  'Smart city projects',
]
const CATEGORY_SET = new Set<string>(CATEGORIES)

export interface Classification {
  category: ProjectCategory
  status: EnhancedProject['status']
  /** Human-readable label, e.g. "Health Clinic" */
  type: string
}

/** Tier 1 — the civic tags we know. Data, not if-chains: extend freely. */
const SEED: Record<string, Classification> = {
  'amenity=hospital': { category: 'Hospitals', status: 'handovered', type: 'Hospital' },
  'amenity=clinic': { category: 'Hospitals', status: 'handovered', type: 'Health Clinic' },
  'amenity=doctors': { category: 'Hospitals', status: 'handovered', type: 'Health Centre' },
  'amenity=school': { category: 'Colleges', status: 'handovered', type: 'School Campus' },
  'amenity=college': { category: 'Colleges', status: 'handovered', type: 'College Campus' },
  'amenity=university': { category: 'Colleges', status: 'handovered', type: 'University Campus' },
  'amenity=library': { category: 'Smart city projects', status: 'handovered', type: 'Public Library' },
  'amenity=bus_station': { category: 'Metro stations', status: 'handovered', type: 'Bus Terminal' },
  'amenity=police': { category: 'Smart city projects', status: 'handovered', type: 'Police Station' },
  'amenity=fire_station': { category: 'Smart city projects', status: 'handovered', type: 'Fire Station' },
  'amenity=marketplace': { category: 'Smart city projects', status: 'handovered', type: 'Public Market' },
  'amenity=community_centre': { category: 'Smart city projects', status: 'handovered', type: 'Community Centre' },
  'railway=station': { category: 'Metro stations', status: 'handovered', type: 'Railway Station' },
  'railway=halt': { category: 'Metro stations', status: 'handovered', type: 'Railway Halt' },
  'highway=construction': { category: 'Road projects', status: 'ongoing', type: 'Road Under Construction' },
  'landuse=construction': { category: 'Smart city projects', status: 'ongoing', type: 'Active Development Site' },
  'building=construction': { category: 'Smart city projects', status: 'ongoing', type: 'Building Under Construction' },
  'man_made=bridge': { category: 'Bridges', status: 'handovered', type: 'Bridge Structure' },
  'bridge=yes': { category: 'Flyovers', status: 'handovered', type: 'Flyover / Elevated Corridor' },
  'power=substation': { category: 'Smart city projects', status: 'handovered', type: 'Power Substation' },
  'man_made=water_works': { category: 'Smart city projects', status: 'handovered', type: 'Water Works' },
  'man_made=water_tower': { category: 'Smart city projects', status: 'handovered', type: 'Water Tower' },
  'amenity=waste_transfer_station': {
    category: 'Smart city projects',
    status: 'handovered',
    type: 'Waste Management Facility',
  },
}

/** The civic-relevant tag keys we're willing to classify at all. */
const RELEVANT_KEYS = [
  'amenity',
  'railway',
  'highway',
  'landuse',
  'building',
  'man_made',
  'power',
  'bridge',
  'public_transport',
  'healthcare',
]

/**
 * The tag signature we classify on, e.g. "amenity=hospital".
 * Returns null when nothing civic-relevant is present.
 */
export function tagSignature(tags: Record<string, string>): string | null {
  // Construction states win — they describe what is HAPPENING, not what is.
  if (tags.highway === 'construction') return 'highway=construction'
  if (tags.landuse === 'construction') return 'landuse=construction'
  if (tags.building === 'construction') return 'building=construction'

  for (const key of RELEVANT_KEYS) {
    const value = tags[key]
    if (value && value !== 'yes' && value !== 'no') return `${key}=${value}`
  }
  if (tags.bridge === 'yes' && tags.highway) return 'bridge=yes'
  return null
}

/** Guardrail: the AI's answer only counts if it fits the app's schema. */
function validate(raw: unknown): Classification | null {
  const c = raw as Partial<Classification> | undefined
  if (!c || typeof c.category !== 'string' || !CATEGORY_SET.has(c.category)) return null
  const status =
    c.status === 'ongoing' || c.status === 'completed' || c.status === 'handovered'
      ? c.status
      : 'handovered'
  const type = typeof c.type === 'string' && c.type.trim() ? c.type.trim().slice(0, 40) : 'Public Facility'
  return { category: c.category as ProjectCategory, status, type }
}

/**
 * Classify a batch of tag signatures. Known ones resolve instantly; unknown
 * ones cost exactly ONE Gemini call for the whole batch, then are cached
 * forever. Signatures the AI rejects are cached as "not civic" too, so we
 * never re-ask about them either.
 */
export async function classifyTags(
  signatures: string[],
  apiKey: string,
): Promise<Map<string, Classification | null>> {
  const result = new Map<string, Classification | null>()
  const unknown: string[] = []

  for (const sig of new Set(signatures)) {
    const seed = SEED[sig]
    if (seed) result.set(sig, seed)
    else unknown.push(sig)
  }
  if (unknown.length === 0) return result

  // Tier 2 — tags the AI classified on an earlier run
  const db = admin.firestore()
  const stillUnknown: string[] = []
  try {
    const refs = unknown.map((sig) =>
      db.collection(CACHE_COLLECTION).doc(sig.replace(/[^a-zA-Z0-9=_-]/g, '_')),
    )
    const snaps = await db.getAll(...refs)
    snaps.forEach((snap, i) => {
      const sig = unknown[i]
      if (!snap.exists) {
        stillUnknown.push(sig)
        return
      }
      const data = snap.data() as { civic?: boolean } & Partial<Classification>
      result.set(sig, data.civic === false ? null : validate(data))
    })
  } catch (error) {
    logger.warn('Tag cache read failed', { error: String(error) })
    stillUnknown.push(...unknown)
  }
  if (stillUnknown.length === 0) return result

  // Tier 3 — one Gemini call for everything genuinely new
  const schema = {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tag: { type: 'string' },
            civic: {
              type: 'boolean',
              description: 'true if this is public/civic infrastructure worth showing on a civic map',
            },
            category: { type: 'string', enum: CATEGORIES },
            status: { type: 'string', enum: ['ongoing', 'completed', 'handovered'] },
            type: { type: 'string', description: 'Short human label, e.g. "Power Substation"' },
          },
          required: ['tag', 'civic', 'category', 'status', 'type'],
        },
      },
    },
    required: ['classifications'],
  }

  try {
    const answer = await geminiJson<{
      classifications: Array<{ tag: string; civic: boolean } & Partial<Classification>>
    }>({
      apiKey,
      system: `You map OpenStreetMap tags to categories for Paridhi, a civic-infrastructure app in India. For each tag decide:
- civic: is this PUBLIC infrastructure a citizen would care about (hospitals, schools, transport, utilities, public works, construction)? Shops, restaurants, ATMs, houses of worship, private offices → civic: false.
- category: the closest of the seven app categories. Utilities/public works/civic buildings → "Smart city projects". Any rail/bus/transit → "Metro stations".
- status: "ongoing" if the tag itself means under-construction/proposed, else "handovered".
- type: a short human label, e.g. "Power Substation".`,
      user: `Classify these OSM tags:\n${stillUnknown.join('\n')}`,
      schema,
    })

    const batch = db.batch()
    for (const item of answer.classifications ?? []) {
      if (!item?.tag || !stillUnknown.includes(item.tag)) continue
      const valid = item.civic ? validate(item) : null
      result.set(item.tag, valid)
      const ref = db.collection(CACHE_COLLECTION).doc(item.tag.replace(/[^a-zA-Z0-9=_-]/g, '_'))
      batch.set(ref, {
        tag: item.tag,
        civic: !!valid,
        ...(valid ?? {}),
        learnedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    }
    await batch.commit()
    logger.info('Classified new OSM tags', { tags: stillUnknown, learned: answer.classifications?.length ?? 0 })
  } catch (error) {
    logger.warn('Tag classification failed — unknown tags skipped this run', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Anything the AI never answered for stays unclassified (skipped, not guessed)
  for (const sig of stillUnknown) if (!result.has(sig)) result.set(sig, null)
  return result
}

/** Synchronous seed-only lookup — used where no AI is available. */
export function classifyFromSeed(tags: Record<string, string>): Classification | null {
  const sig = tagSignature(tags)
  return sig ? (SEED[sig] ?? null) : null
}
