#!/usr/bin/env node
// Seed the ChromaDB `projects` collection from the merged dataset.
//
// Embeddings are computed locally by Chroma's default embedding function
// (all-MiniLM-L6-v2 via ONNX) — no API, no tokens, ₹0.
//
// Usage:
//   CHROMA_URL=https://paridhi-chroma-xxxx.a.run.app CHROMA_TOKEN=... node script/seed-chroma.mjs
//
// Run after every dataset refresh (fetch-live-projects.mjs). The weekly
// GitHub Action does this automatically when CHROMA_URL/TOKEN secrets exist.

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChromaClient } from 'chromadb'
import { DefaultEmbeddingFunction } from '@chroma-core/default-embed'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHROMA_URL = process.env.CHROMA_URL
const CHROMA_TOKEN = process.env.CHROMA_TOKEN

if (!CHROMA_URL) {
  console.error('CHROMA_URL is required (your Cloud Run service URL).')
  process.exit(1)
}

// --- Load the merged dataset out of the TS sources (data-only literals) ----

function loadCurated() {
  const ts = readFileSync(resolve(ROOT, 'web/src/data/projectsEnhanced.ts'), 'utf8')
  const match = ts.match(/export const curatedProjects[^=]*= (\[[\s\S]*?\n\])/)
  if (!match) throw new Error('Could not locate curatedProjects array')
  return eval(match[1]) // plain object/array literals only
}

function loadLive() {
  const ts = readFileSync(resolve(ROOT, 'web/src/data/projectsLive.ts'), 'utf8')
  const match = ts.match(/export const liveProjects[^=]*= (\[[\s\S]*\])/)
  if (!match) return []
  return JSON.parse(match[1])
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Same dedup rule as the app: name match, or same category within 250 m
function mergeDatasets(curated, live) {
  const merged = [...curated]
  for (const item of live) {
    const dup = curated.some(
      (c) =>
        c.name.toLowerCase() === item.name.toLowerCase() ||
        (c.category === item.category && haversineKm(c.lat, c.lng, item.lat, item.lng) < 0.25),
    )
    if (!dup) merged.push(item)
  }
  return merged
}

// --- Seed -------------------------------------------------------------------

async function main() {
  const projects = mergeDatasets(loadCurated(), loadLive())
  console.log(`Seeding ${projects.length} projects into Chroma at ${CHROMA_URL} …`)

  const url = new URL(CHROMA_URL)
  const ssl = url.protocol === 'https:'
  const client = new ChromaClient({
    host: url.hostname,
    port: url.port ? Number(url.port) : ssl ? 443 : 8000,
    ssl,
    ...(CHROMA_TOKEN ? { headers: { Authorization: `Bearer ${CHROMA_TOKEN}` } } : {}),
  })

  const collection = await client.getOrCreateCollection({
    name: 'projects',
    embeddingFunction: new DefaultEmbeddingFunction(),
    metadata: { 'hnsw:space': 'cosine' },
  })

  const BATCH = 25
  for (let i = 0; i < projects.length; i += BATCH) {
    const batch = projects.slice(i, i + BATCH)
    await collection.upsert({
      ids: batch.map((p) => p.id),
      documents: batch.map(
        (p) =>
          `${p.name}. ${p.category}. ${p.type ?? ''}. ${p.description} ${p.longDescription ?? ''} Located at ${p.location}.`,
      ),
      metadatas: batch.map((p) => ({
        name: p.name,
        category: p.category,
        status: p.status,
        lat: p.lat,
        lng: p.lng,
      })),
    })
    console.log(`  upserted ${Math.min(i + BATCH, projects.length)}/${projects.length}`)
  }

  // Evict tombstones. `upsert` only adds and updates — it never deletes, so a
  // project that disappears from OpenStreetMap between crawls would keep its
  // vector forever. Semantic search would then return an id the app can no
  // longer resolve, and silently drop the hit: fewer results than it claims,
  // with no error anywhere. Delete anything not in the dataset we just seeded.
  const live = new Set(projects.map((p) => p.id))
  const existing = await collection.get({ include: [] })
  const stale = (existing.ids ?? []).filter((id) => !live.has(id))

  if (stale.length) {
    for (let i = 0; i < stale.length; i += BATCH) {
      await collection.delete({ ids: stale.slice(i, i + BATCH) })
    }
    console.log(`  evicted ${stale.length} stale vector(s): ${stale.slice(0, 10).join(', ')}${stale.length > 10 ? ' …' : ''}`)
  } else {
    console.log('  no stale vectors to evict')
  }

  const count = await collection.count()
  console.log(`Done — collection now holds ${count} vectors (dataset has ${projects.length}).`)

  if (count !== projects.length) {
    console.warn(`⚠ Vector count does not match the dataset — the index is not a faithful mirror.`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
