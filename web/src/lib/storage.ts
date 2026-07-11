// Bounded browser cache — TTL + LRU eviction + quota recovery.
//
// localStorage is a hard ~5 MB cap shared by the whole origin. Every cache we
// keep (scanned areas, semantic searches, AI insights, 3D footprints) used to
// be write-once/never-evicted, so a user who explores enough eventually fills
// it and EVERY write starts throwing QuotaExceededError — including the ones
// that matter, like exploration progress.
//
// This module gives each cache a namespace with:
//   • a TTL          — stale entries are dropped on read and on prune
//   • a max size     — least-recently-used entries evicted past the limit
//   • quota recovery — a failed write prunes hard and retries once
//
// Entries record `at` (written) and `hit` (last read) so LRU is by real use.

interface Entry<T> {
  at: number
  hit: number
  value: T
}

export interface CacheOptions {
  /** Key prefix, e.g. "paridhi:liveNearby:v2:" */
  prefix: string
  /** Time-to-live in ms; Infinity for "until evicted by size". */
  ttlMs: number
  /** Max entries kept in this namespace. */
  maxEntries: number
}

function keysFor(prefix: string): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(prefix)) keys.push(key)
  }
  return keys
}

function readEntry<T>(key: string): Entry<T> | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Entry<T>
    if (typeof parsed?.at !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export class BoundedCache<T> {
  private readonly options: CacheOptions

  constructor(options: CacheOptions) {
    this.options = options
  }

  private fullKey(key: string): string {
    return this.options.prefix + key
  }

  /** Drop expired entries, then LRU-evict down to maxEntries. */
  prune(extraEvictions = 0): void {
    const { prefix, ttlMs, maxEntries } = this.options
    const now = Date.now()
    const live: Array<{ key: string; hit: number }> = []

    for (const key of keysFor(prefix)) {
      const entry = readEntry<T>(key)
      if (!entry || (ttlMs !== Infinity && now - entry.at > ttlMs)) {
        localStorage.removeItem(key)
        continue
      }
      live.push({ key, hit: entry.hit ?? entry.at })
    }

    const limit = Math.max(0, maxEntries - extraEvictions)
    if (live.length <= limit) return

    live.sort((a, b) => a.hit - b.hit) // oldest use first
    for (const { key } of live.slice(0, live.length - limit)) {
      localStorage.removeItem(key)
    }
  }

  get(key: string): T | null {
    const fullKey = this.fullKey(key)
    const entry = readEntry<T>(fullKey)
    if (!entry) return null

    if (this.options.ttlMs !== Infinity && Date.now() - entry.at > this.options.ttlMs) {
      localStorage.removeItem(fullKey)
      return null
    }

    // touch for LRU (best-effort — never let this break a read)
    try {
      localStorage.setItem(fullKey, JSON.stringify({ ...entry, hit: Date.now() }))
    } catch {
      // ignore
    }
    return entry.value
  }

  set(key: string, value: T): void {
    const now = Date.now()
    const payload = JSON.stringify({ at: now, hit: now, value } satisfies Entry<T>)

    const write = () => localStorage.setItem(this.fullKey(key), payload)
    try {
      write()
    } catch {
      // Quota hit (or close to it): prune this namespace hard, then retry once.
      try {
        this.prune(Math.ceil(this.options.maxEntries / 2))
        write()
      } catch {
        // Still failing — the cache is a nice-to-have, so give up silently.
      }
    }

    // Keep the namespace within bounds on a normal write too.
    if (keysFor(this.options.prefix).length > this.options.maxEntries) {
      try {
        this.prune()
      } catch {
        // ignore
      }
    }
  }

  remove(key: string): void {
    try {
      localStorage.removeItem(this.fullKey(key))
    } catch {
      // ignore
    }
  }

  /** Drop every entry in this namespace. */
  clear(): void {
    for (const key of keysFor(this.options.prefix)) localStorage.removeItem(key)
  }
}

// ---------------------------------------------------------------------------
// The app's caches. Sizes are budgeted against localStorage's ~5 MB ceiling;
// exploration progress and auth are NOT caches and are never evicted.
// ---------------------------------------------------------------------------

/** Live OSM scans, ~40 projects per ~1 km cell. The biggest consumer. */
export const scanCache = new BoundedCache<unknown>({
  prefix: 'paridhi:liveNearby:v2:',
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 40,
})

/** Semantic search results, keyed by query. */
export const semanticCache = new BoundedCache<unknown>({
  prefix: 'paridhi:semantic:v1:',
  ttlMs: 6 * 60 * 60 * 1000,
  maxEntries: 50,
})

/** AI project insights (rarely change → long TTL). */
export const insightCache = new BoundedCache<unknown>({
  prefix: 'paridhi:insight:v1:',
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 60,
})

/** 3D building footprints — polygons, so relatively heavy per entry. */
export const footprintCache = new BoundedCache<unknown>({
  prefix: 'paridhi:footprint:v1:',
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 25,
})

/** Which posts this device voted on (tiny, but unbounded without a cap). */
export const voteCache = new BoundedCache<'up' | 'down'>({
  prefix: 'paridhi-vote-',
  ttlMs: 90 * 24 * 60 * 60 * 1000,
  maxEntries: 300,
})

/**
 * Housekeeping on app start: prune every cache, and drop legacy keys from
 * older cache versions that nothing reads anymore.
 */
const LEGACY_PREFIXES = ['paridhi:liveNearby:v1:', 'paridhi:semanticSearch:', 'paridhi:insights:']

export function pruneAllCaches(): void {
  try {
    for (const prefix of LEGACY_PREFIXES) {
      for (const key of keysFor(prefix)) localStorage.removeItem(key)
    }
    scanCache.prune()
    semanticCache.prune()
    insightCache.prune()
    footprintCache.prune()
    voteCache.prune()
  } catch {
    // storage unavailable (private mode) — nothing to do
  }
}
