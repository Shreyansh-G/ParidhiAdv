<div align="center">

# 🧭 Paridhi · परिधि

### *pa·ri·dhi* — Sanskrit, "the circumference." The circle around you.

**A civic-infrastructure explorer for India.**
Maps what's being built near you, and computes what *should* be.

[![CI](https://github.com/Shreyansh-G/ParidhiAdv/actions/workflows/ci.yml/badge.svg)](https://github.com/Shreyansh-G/ParidhiAdv/actions/workflows/ci.yml)
![Vulnerabilities](https://img.shields.io/badge/npm%20audit-0%20vulnerabilities-brightgreen)
![Tests](https://img.shields.io/badge/tests-40%20passing-success)
![Lint](https://img.shields.io/badge/eslint-0%20errors-success)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![React](https://img.shields.io/badge/React-19-61dafb)
![Node](https://img.shields.io/badge/Node-22-339933)

### [**→ Live app**](https://paridhi-adv.vercel.app)

</div>

---

## Try it in 60 seconds

Open the [**live app**](https://paridhi-adv.vercel.app) — on a phone if you can, since it's GPS-driven —
sign in, allow location, then:

| Tap | What it's actually doing |
|---|---|
| **SCAN** | Queries OpenStreetMap's Overpass API **from your browser**. No backend, no cost. |
| **NEEDS** | Gravity model + 2SFCA over an OSM-derived population grid. Red = people, no facilities. |
| **WALK** | Solves a TSP across nearby projects (nearest-neighbour, then 2-opt). |
| **DEEP** | A LangGraph agent crawls OSM *and* local news, geocodes what it reads, and validates it. ~30–60 s. |
| **Search** → *"heart treatment"* | Vector search. Ranks hospitals top — the phrase appears nowhere in the data. |

It works in any Indian town, not a hardcoded list of cities. Try it wherever you actually are.

---

## Contents

[Problem](#problem) · [Design rule](#design-rule) · [Architecture](#architecture) · [Deep Scan](#deep-scan) · [Retrieval](#retrieval) · [Maths](#maths) · [Security](#security) · [Cost](#cost) · [Lessons](#lessons) · [Stack](#stack) · [Layout](#layout) · [Setup](#setup) · [Deploy](#deploy) · [CI](#ci) · [Troubleshooting](#troubleshooting) · [Glossary](#glossary) · [Limits](#limits) · [Credits](#credits)

---

## Problem

Two questions a citizen can't easily answer: **what is being built near me**, and **what is
missing near me**. The first is scattered across PDFs and district portals. The second nobody
publishes at all.

Paridhi answers both from free public data, and it works **anywhere in India** — not just the metros.
Most civic tools hardcode a handful of big cities, which leaves out most of the country.

Hence the name: *paridhi* (परिधि) is Sanskrit for **circumference**. The app is about the circle you
live inside.

## Design rule

> **Deterministic maths measures. The vector DB retrieves. The LLM only writes prose.**

Anything with a closed form gets a formula, not a prompt — formulas are free, instant, and testable.
The model is used for the one thing it's uniquely good at: turning messy text into structured facts.
It never produces a score, and never reaches the map without passing a non-AI validator.

## Architecture

```
BROWSER          React 19 · TS strict · Vite · Leaflet · three.js (lazy)     → Vercel
                 Queries Overpass/OSM directly. No backend hop, no cost,
                 and the map survives a backend outage.
                 All scoring maths runs here — deterministic, so it's free and testable.
                     │
                     │  only what needs a server: AI, writes, secrets
                     ▼
BACKEND          9 Cloud Functions · Node 22 · asia-south1                   → Firebase
                 writes:  createPost · votePost · reportPost
                          moderatePostOnCreate · getLeaderboard
                 AI:      askCivicAssistant · generateProjectInsight
                          semanticSearchProjects · discoverProjectsNear
                 The model API key lives here and nowhere else.
                     │
                     ▼
VECTORS          ChromaDB, scale-to-zero                                     → Cloud Run
                 all-MiniLM-L6-v2 runs *inside* the server ⇒ 0 tokens.
```

Each tier degrades without the one below it. No Chroma → substring search. No backend → map, Needs
heatmap, walk planner and 3D viewer all still work on free OSM data.

## Deep Scan

`discoverProjectsNear` — a LangGraph pipeline. [functions/src/discoveryAgent.ts](functions/src/discoveryAgent.ts)

```
START → localize ─┬→ gatherOsm  ─┐
                  └→ gatherNews ─┴→ extract → geocode → mergeValidate → END
                     (parallel)     (1 LLM)   (Nominatim)  (no AI)
```

**The escalation asymmetry.** News about a hamlet doesn't exist; news about a state is irrelevant.
So the *search* climbs the place hierarchy — hamlet → nearby towns → district — **pooling every
rung**. But *acceptance* never widens:

```ts
const acceptKm = Math.min(Math.max(state.radiusKm * 2.5, 10), 20)
```

It climbs to find the story, and still only pins projects near you. A hallucinated project 400 km
away is dropped by arithmetic, not by trust.

Pooling matters: stopping at the first non-empty rung was a trap — the towns rung returned 8 crime
stories, which would have satisfied a naive "found something" check and starved the district rung
where the real news lived.

**Cache:** a scan within `CACHE_HIT_RADIUS_KM = 0.5` and < 24 h is served free. Empty results are
**never** cached — caching one locked an entire area for a day.

**Fan-in needs a reducer**, or the last parallel writer silently clobbers the first:

```ts
notes: Annotation<string[]>({ reducer: (a, b) => [...(a ?? []), ...(b ?? [])] })
```

**Prompt injection:** articles are fenced in `<article>` tags and declared as data, never
instructions.

## Retrieval

Chroma's embedder runs **in-process**, so documents *and* queries are embedded server-side: semantic
search costs **zero tokens**, not "almost nothing".

`scoreProjectRelevance()` reuses this to rank news headlines by cosine distance to the nearest real
project — replacing a hand-written English keyword regex, with no keyword list to maintain.

Verified on 155 vectors, using words absent from the source text:

| query | top 3 |
|---|---|
| "heart treatment" | Delhi Heart & Lung · Manav Medicare · SRHC — all **hospitals** |
| "crossing the river" | Tilak Bridge · Pragati Maidan · Mukarba Chowk — all **bridges** |

## Maths

All in [`web/src/lib`](web/src/lib), and the only code with unit tests — 40 of them.

**Feed ranking** — Wilson score lower bound (95% CI), so 1 upvote can't outrank 99:

```
        p̂ + z²/2n − z·√( p̂(1−p̂)/n + z²/4n² )
wilson = ──────────────────────────────────────      z = 1.96
                      1 + z²/n

hot = wilson(u+1, n+1) · exp(−λ · ageHours) · max(0, 1 − 0.15·reports)
      λ = ln2 / 24        (24 h half-life)
```

**Civic gaps** — gravity model + 2SFCA (two-step floating catchment area). A 5 km circle would call
4.9 km "served" and 5.1 km "abandoned"; access isn't a step function. And one hospital for 50,000
people ≠ one for 500 — hence step 1.

```
w(d)  = exp(−(d/d₀)²)                          d₀ = 5 km, haversine
R(j)  = S(j) / Σₖ pop(k)·w(d_kj)               supply : demand
A(i)  = Σⱼ R(j)·w(d_ij)                        accessibility
gap(i)= 1 − A(i)/max(A)                        normalised 0..1
```

0.02° grid over an 18 km window, ≤ 400 cells. Returns **all** inhabited cells, not just the worst —
keeping only the top 15% deleted the well-served ones, so the user's own area vanished. Population
from OSM `place` nodes (`city` 300k … `hamlet` 1k), which is why it works anywhere.

**Walk planner** — TSP, NP-hard, so: nearest-neighbour construction `O(k²)`, then 2-opt until no
gain. If two legs cross, uncrossing them is always shorter.

```
if d(i,j) + d(i+1,j+1) < d(i,i+1) + d(j,j+1)  →  reverse path between them
```

Stops are **weighted-random sampled**, not "nearest 6" — otherwise the route is deterministic and
identical every run.

**XP** — Shannon entropy over the 7 categories, so grinding one isn't optimal:

```
H = −Σ pᵢ log₂ pᵢ                     max = log₂7 ≈ 2.807
diversity = 1 + 0.5 · H/log₂7         → 1.0× … 1.5×
xpForLevel(n) = 200·(1.35ⁿ⁻¹ − 1)/0.35
```

**GPS anti-cheat** — accuracy gate (> 100 m rejected), accuracy-weighted EMA, speed gate
(> 25 km/h = vehicle = no auto-explore).

**Geofencing** — grid hash on `⌊lat/0.01⌋_⌊lng/0.01⌋` (~1.1 km). No radius exceeds a cell, so every
hit is in the 3×3 block: `O(n)` scan → `O(1)` hash.

## Security

The Firebase web config is **public by design** — it ships in the bundle. So a valid token proves *a
user exists*, not that *our app* made the call. Everything follows from that.

| Control | Attack it stops |
|---|---|
| **Server-owned writes** | `authorName` used to be whatever the client claimed — "Municipal Corporation ✓" was a legal value. It now comes from the verified token; `firestore.rules` refuses client creates. |
| **Per-user rate limits** | assistant 60/day · deepScan 25/day · insight 40/day · createPost 15/h · vote 300/h. **Fails open** — a broken limiter must not take the app down. |
| **Project-wide AI budget** | 600 calls/day across *all* users. Per-user limits don't protect a **shared** quota: N throwaway accounts, each inside its own limit, still drain it collectively. |
| **`maxInstances`** | 5 (AI) / 10 (rest). A ceiling on concurrency is a ceiling on the bill. |
| **Prompt fencing** | Untrusted text delimited and declared as data, never instructions. |
| **Guardrails** | Model output passes a non-AI validator (category enum, coord bounds, distance gate) before reaching the map. |
| **TTL** | Every cache carries `expiresAt`; the browser cache is a bounded LRU. |

When the AI budget is spent, features **degrade rather than fail**: Deep Scan still returns every OSM
result and skips only news. **Moderation is deliberately not counted** — safety must never be the
thing that runs out.

Full threat model and accepted risks: [SECURITY.md](SECURITY.md).

## Cost

Cost was treated as a constraint the architecture lives inside, like latency — and it produced most
of the interesting decisions: querying OSM from the browser (a hop you don't make is a hop you don't
pay for, *and* the map survives an outage), embedding in-process, a 3-tier tag classifier
(table → cache → model, so AI cost trends to zero), closed-form maths instead of prompts.

Free: Overpass, Nominatim, Google News RSS, in-process embeddings, Cloud Run at zero scale, Gemini
flash-lite, Vercel, GitHub Actions, Firebase Auth/Firestore. Honest caveat: Cloud Functions need
Blaze; Artifact Registry + the Chroma bucket sit just outside the always-free tiers — a few rupees a
month.

The invariant that matters: **no code path — bug, retry loop, or abuser — can produce an unbounded
bill.**

## Lessons

**Overpass regex bypasses the tag index.** Same coordinates:

| query | result |
|---|---|
| regex `nwr[~"amenity"~"hospital\|clinic"]` | **51 s → timeout → 0 results** |
| exact `nwr["amenity"="hospital"]` | **2.0 s → 21 results** |

It also returns **HTTP 200 with a `remark` field** on failure — a failure wearing the costume of a
success.

**Google News RSS silently ignores negative operators.** `-killed -fraud` did nothing, and pushed
good articles out of the window. Filtering moved into our code.

**`npm audit fix --force` was wrong.** All 8 advisories traced to `uuid@9`. npm's fix —
`firebase-admin@14` — removes the `admin.firestore` namespace (build fails) *and still ships the
vulnerable uuid*. The advisory needs uuid `v3/v5/v6` with a `buf` arg; the tree only ever calls
`v4()`. A transitive override to `uuid@11` was the safe fix — verified by reading its CJS export map
and loading every consumer, not by assuming.

**`betaTool()` takes `inputSchema` but returns `input_schema`.** Reached production as `"undefined"
is not valid JSON`. The smoke test missed it because it hand-wrote the tool objects.

**A ref read during render never corrects itself.** `isMonitoring: watchIdRef.current !== null` —
refs are assigned in effects, after render, and never trigger one. It reported `false` on first paint
forever.

**Never gate a feature on a permission the platform can't grant.** Explore required *both* location
and notifications. iOS Safari doesn't define `window.Notification` at all unless the site is
installed to the home screen — so the gate was unsatisfiable and the map was unreachable on iPhone,
with no dismiss button. Location is required now; notifications are optional. Desktop testing will
never show you this.

**A `<div>` with `cursor-pointer` is not a button.** The Account permission switches rendered state
and had no `onClick`. They looked interactive and did nothing. They're real `<button role="switch">`
elements now — and the location toggle calls `getCurrentPosition()`, because the browser only shows
its prompt in response to an actual request. Setting a flag in localStorage asks no one anything.

## Stack

React 19 · TypeScript strict · Vite · Tailwind · Leaflet + supercluster · three.js / r3f (lazy) ·
Vitest — Firebase Functions v2 (Node 22) · Firestore · **LangGraph.js** · Gemini (`@google/genai`) ·
**ChromaDB** — OpenStreetMap/Overpass · Nominatim · Google News RSS — GitHub Actions · Vercel

## Layout

```
web/src/lib/          ★ the maths + service layer
  ranking.ts            Wilson + decay          civicImpact.ts    gravity + 2SFCA
  routePlanner.ts       TSP + 2-opt             progression.ts    entropy XP, streaks
  locationFilter.ts     GPS gate, EMA, speed    spatialIndex.ts   grid hash
  liveProjectsService.ts  browser → Overpass    populationService.ts  OSM place nodes
  storage.ts            bounded LRU caches      buildingGeometry.ts   OSM footprints
  __tests__/            40 unit tests

functions/src/
  index.ts              posts, votes, reports, moderation, leaderboard
  ai.ts                 assistant, insights, semantic search
  discoveryAgent.ts   ★ the LangGraph pipeline
  tagClassifier.ts      seed → learned → AI, cached forever
  rateLimit.ts          per-user limits + global AI budget
  chroma.ts             vector retrieval        overpassLive.ts   exact-match OSM
  gemini.ts             model adapter           appCheck.ts       callable options

script/                 fetch-live-projects · seed-chroma · check-data-sync
infra/chroma/           Cloud Run deploy
firestore.rules         server-owned writes: clients cannot create posts
```

## Setup

Node 20+ (functions need 22).

```bash
git clone https://github.com/Shreyansh-G/ParidhiAdv.git
cd ParidhiAdv/web && npm install
cp .env.example .env        # fill in from Firebase console
npm run dev                 # → localhost:5173
```

**Firebase:** create a project → Authentication → Google → Enable → Firestore → create (asia-south1)
→ Project settings → Web app → copy config into `.env`.

```ini
VITE_FIREBASE_API_KEY=…
VITE_FIREBASE_AUTH_DOMAIN=…
VITE_FIREBASE_PROJECT_ID=…
VITE_FIREBASE_STORAGE_BUCKET=…
VITE_FIREBASE_MESSAGING_SENDER_ID=…
VITE_FIREBASE_APP_ID=…
VITE_FIREBASE_VAPID_KEY=          # Cloud Messaging → Web Push certs. Optional.
VITE_FIREBASE_FUNCTIONS_REGION=asia-south1
VITE_USE_FIREBASE_EMULATORS=false
VITE_DEFAULT_LAT=28.6139
VITE_DEFAULT_LNG=77.2090
```

These values are **public by design** — they ship in the bundle regardless. Security comes from
Firestore rules and server-side validation, not from hiding them.

**That's enough to run it.** Map, live OSM scanning, Needs heatmap, walk planner and 3D viewer all
work with no backend.

**Backend** (optional — AI chat, Deep Scan, posting). Needs Blaze. Free Gemini key from
[aistudio.google.com](https://aistudio.google.com/apikey):

```bash
cd functions && npm install
firebase functions:secrets:set GEMINI_API_KEY
npm run build && firebase deploy --only functions,firestore:rules,firestore:indexes
```

> `--only firestore:rules,functions` sometimes deploys *only* Firestore and silently skips functions.
> Deploy them separately if unsure.

**Vectors** (optional — semantic search). See [infra/chroma/README.md](infra/chroma/README.md), then
`npm run seed:chroma`. It exits non-zero if the vector count ≠ the dataset count.

## Deploy

**Vercel** — import the repo → **Root Directory: `web`** ← *the step everyone misses* → paste the 11
`VITE_*` vars → deploy.

**Then Firebase → Authentication → Settings → Authorized domains → add your `.vercel.app`.**
Skip it and sign-in dies with `auth/unauthorized-domain`; since sign-in gates the app, you're locked
out with no clue why.

HTTPS is not optional: browsers refuse geolocation over plain HTTP, so you cannot test GPS on a phone
against a LAN address.

## CI

```bash
npm test          # 40 unit tests
npm run lint      # 0 errors
npm run check:data
```

Every push: typecheck → lint → test → build (web), build (functions), **dataset sync**.

That last one exists because `web/` and `functions/` are separate packages, each carrying a copy of
the dataset. Project **IDs are the join key** for the AI tools, the Chroma vectors and the cached
insights — if the copies drift, a project doesn't crash, it becomes **silently unmatchable** and
results quietly go missing. The guard turns a comment into an enforced invariant.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `auth/unauthorized-domain` | Domain not in Firebase → Auth → Settings → Authorized domains |
| Vercel: "no build script" | Root Directory isn't `web` |
| GPS never works on phone | You're on `http://`. Geolocation requires HTTPS. |
| Map stuck on Delhi | That's `VITE_DEFAULT_LAT/LNG`; it sits there until a real fix arrives |
| Scan returns nothing | Overpass down/limiting. 4 mirrors, radius escalates 5 → 8 → 12.5 → 20 km |
| Assistant says "back tomorrow" | Global AI budget spent. Resets midnight UTC. Map/search unaffected. |
| Semantic search empty | Chroma unreachable or unseeded → falls back to substring |

## Glossary

**Overpass** — free query API for OpenStreetMap. **Nominatim** — OSM geocoder.
**Embedding** — numbers representing text *meaning*; similar meanings sit close together.
**Vector DB** — stores embeddings, finds nearest meaning fast (here: ChromaDB).
**LangGraph** — AI workflows as a graph of steps, so parts run in parallel.
**Prompt injection** — untrusted text trying to issue instructions to the model.
**Scale-to-zero** — server shuts down when idle (5–10 s cold start).
**Fail open** — on infra error, allow the request. Right for a rate limiter; wrong for auth.
**Wilson score** — a rating honest about sample size. **2SFCA** — health-geography access measure
accounting for distance *and* competition. **2-opt** — TSP improvement that uncrosses crossed paths.
**Shannon entropy** — how spread out a distribution is.

## Limits

- **Population is estimated** from OSM `place` types, not census. Good enough to *rank* underserved
  areas; not to quote headcounts.
- **App Check is in monitor mode.** Rate limits + the global budget bound abuse; reCAPTCHA
  enforcement is a documented deferral.
- **Google News RSS has no API contract.** Deep Scan degrades to its OSM half if it breaks.
- **3D viewer is a 911 KB lazy chunk** — slow on rural 3G, free until opened.
- **Semantic search is weak on transport queries** — metro records are mostly just a name, so the
  embedder has little to work with. Fix: enrich the descriptions.

## Credits

**Hackathon MVP, March 2026** — Team ShadShaktiAI: Shreyansh (lead), Jatin, Aman, Supriya, Nirbhay,
Shreyashi. At that point Paridhi was a map, a feed, Google auth and a PWA shell.

**The advanced version — this repo.** Everything past that point is my work: the LangGraph discovery
agent and its escalation strategy, ChromaDB semantic search, the gravity-model/2SFCA gap analysis,
the maths layer (Wilson ranking, TSP planner, entropy XP, GPS filtering, geofence index), the
security model (server-owned writes, rate limits, the project-wide AI budget, prompt fencing, TTLs),
the live OSM pipeline, the 3D viewer, the test suite and CI.

---

<div align="center">

Data © OpenStreetMap contributors (ODbL) · Geocoding by Nominatim

</div>
