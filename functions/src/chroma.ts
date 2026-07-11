// ChromaDB client for Cloud Functions — semantic retrieval layer.
//
// Retrieval is Chroma's job (vectors, all-MiniLM embeddings computed
// in-process — no API tokens); Claude only composes answers on top.
// Configure with:
//   CHROMA_URL   — Cloud Run service URL (functions/.env or env var)
//   CHROMA_TOKEN — Chroma auth token (Firebase secret)

import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { ChromaClient, type Collection } from 'chromadb'
import { DefaultEmbeddingFunction } from '@chroma-core/default-embed'
import { enhancedProjects, type EnhancedProject } from './projectsData'

export const chromaToken = defineSecret('CHROMA_TOKEN')

export interface SemanticHit {
  project: EnhancedProject
  /** cosine similarity 0..1 (higher = closer) */
  score: number
}

let collectionPromise: Promise<Collection> | null = null

function getCollection(): Promise<Collection> {
  if (!collectionPromise) {
    const url = process.env.CHROMA_URL
    if (!url) throw new Error('CHROMA_URL is not configured')

    const token = chromaToken.value()
    const parsed = new URL(url)
    const ssl = parsed.protocol === 'https:'
    const client = new ChromaClient({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : ssl ? 443 : 8000,
      ssl,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    })
    collectionPromise = client
      .getOrCreateCollection({
        name: 'projects',
        embeddingFunction: new DefaultEmbeddingFunction(),
        metadata: { 'hnsw:space': 'cosine' },
      })
      .catch((err) => {
        collectionPromise = null // allow retry on next invocation
        throw err
      })
  }
  return collectionPromise
}

function toHits(ids: string[], distances: number[]): SemanticHit[] {
  const hits: SemanticHit[] = []
  for (let i = 0; i < ids.length; i++) {
    const project = enhancedProjects.find((p) => p.id === ids[i])
    if (!project) continue // vector for a project no longer in the dataset
    hits.push({ project, score: Number((1 - (distances[i] ?? 1)).toFixed(4)) })
  }
  return hits
}

/** Natural-language semantic search over the project vectors. */
export async function queryProjects(
  text: string,
  k = 8,
  filters?: { category?: string; status?: string },
): Promise<SemanticHit[]> {
  try {
    const collection = await getCollection()
    const where: Record<string, string>[] = []
    if (filters?.category) where.push({ category: filters.category })
    if (filters?.status) where.push({ status: filters.status })

    const result = await collection.query({
      queryTexts: [text],
      nResults: Math.min(Math.max(k, 1), 20),
      ...(where.length === 1 ? { where: where[0] } : where.length > 1 ? { where: { $and: where } } : {}),
    })
    return toHits(result.ids?.[0] ?? [], (result.distances?.[0] ?? []) as number[])
  } catch (error) {
    logger.warn('Chroma query failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * Score how "infrastructure-project-like" each text is, by embedding it and
 * measuring cosine similarity to the nearest real project vector.
 *
 * This replaces a hand-written English keyword regex for filtering news
 * headlines: it is language-agnostic-ish, needs no keyword maintenance, and
 * costs ZERO tokens (the embeddings run inside the Chroma server). One round
 * trip scores the whole batch.
 *
 * Returns a score per input (0..1, higher = more project-like), or an empty
 * array if Chroma is unreachable — callers must fall back gracefully.
 */
export async function scoreProjectRelevance(texts: string[]): Promise<number[]> {
  if (texts.length === 0) return []
  try {
    const collection = await getCollection()
    const result = await collection.query({
      queryTexts: texts,
      nResults: 1, // just the closest project — how close is "project-like"?
    })
    const distances = (result.distances ?? []) as number[][]
    return texts.map((_, i) => {
      const d = distances[i]?.[0]
      return typeof d === 'number' ? Number((1 - d).toFixed(4)) : 0
    })
  } catch (error) {
    logger.warn('Chroma relevance scoring failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/** Nearest neighbors of an existing project (its stored vector). */
export async function similarToProject(projectId: string, k = 4): Promise<SemanticHit[]> {
  try {
    const collection = await getCollection()
    const stored = await collection.get({ ids: [projectId], include: ['embeddings'] })
    const embedding = stored.embeddings?.[0]
    if (!embedding) return []

    const result = await collection.query({
      queryEmbeddings: [embedding as number[]],
      nResults: k + 1, // the project itself comes back as its own nearest neighbor
    })
    return toHits(result.ids?.[0] ?? [], (result.distances?.[0] ?? []) as number[]).filter(
      (hit) => hit.project.id !== projectId,
    )
  } catch (error) {
    logger.warn('Chroma similar lookup failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
