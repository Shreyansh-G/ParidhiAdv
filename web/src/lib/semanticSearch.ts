// Client wrapper for the ChromaDB-backed semantic search callable.
//
// Retrieval is pure vector math (no LLM), so calls are cheap; results are
// still cached locally so repeated queries cost nothing at all. Callers must
// always keep substring search as the instant/offline fallback.

import { httpsCallable } from 'firebase/functions'
import { firebaseFunctions } from './firebase'
import { semanticCache } from './storage'

export interface SemanticHit {
  id: string
  name: string
  category: string
  score: number
}

// TTL (6 h), size cap and LRU eviction are handled by the shared cache
function readCache(key: string): SemanticHit[] | null {
  return semanticCache.get(key) as SemanticHit[] | null
}

function writeCache(key: string, hits: SemanticHit[]): void {
  semanticCache.set(key, hits)
}

async function call(payload: Record<string, string>): Promise<SemanticHit[] | null> {
  if (!firebaseFunctions) return null
  try {
    const fn = httpsCallable<Record<string, string>, { hits: SemanticHit[] }>(
      firebaseFunctions,
      'semanticSearchProjects',
    )
    const result = await fn(payload)
    return result.data?.hits ?? []
  } catch (error) {
    console.warn('Semantic search unavailable', error)
    return null
  }
}

/** Meaning-based project search. Null = backend unavailable (use fallback). */
export async function semanticSearch(query: string): Promise<SemanticHit[] | null> {
  const key = `q:${query.toLowerCase().trim()}`
  const cached = readCache(key)
  if (cached) return cached

  const hits = await call({ mode: 'query', query })
  if (hits) writeCache(key, hits)
  return hits
}

/** Nearest-neighbor projects of one project. Null = backend unavailable. */
export async function similarProjects(projectId: string): Promise<SemanticHit[] | null> {
  const key = `sim:${projectId}`
  const cached = readCache(key)
  if (cached) return cached

  const hits = await call({ mode: 'similar', projectId })
  if (hits) writeCache(key, hits)
  return hits
}
