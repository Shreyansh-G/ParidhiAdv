import * as admin from 'firebase-admin'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'
import { moderateContent, geminiApiKey } from './ai'
import { enhancedProjects } from './projectsData'
import { enforceRateLimit } from './rateLimit'
import { CALLABLE_OPTS } from './appCheck'

admin.initializeApp()

// AI features (assistant chat, project insights, Chroma semantic search) live in ./ai
export { askCivicAssistant, generateProjectInsight, semanticSearchProjects } from './ai'
// Deep Scan — LangGraph discovery pipeline (OSM + local news → geocode → map)
export { discoverProjectsNear } from './discoveryAgent'

const db = admin.firestore()

const POST_CATEGORIES = new Set(['Roads', 'Smart City', 'Transport', 'Healthcare', 'General'])
// Only real images — never an arbitrary data: URI that ends up in the DOM
const IMAGE_DATA_URI = /^data:image\/(webp|jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/
const MAX_IMAGE_CHARS = 400_000

/**
 * Create a community post — SERVER-SIDE ONLY.
 *
 * Posts used to be written straight from the client, so `authorName` was
 * whatever the client claimed (trivial impersonation: "Delhi Municipal
 * Corporation ✓"), and nothing could rate-limit spam — each post triggers a
 * Gemini moderation call. Owning the write fixes both: identity comes from the
 * verified auth token, and the budget is enforced before anything is written.
 */
export const createPost = onCall(CALLABLE_OPTS, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to post.')
  }
  const uid = request.auth.uid
  await enforceRateLimit(uid, 'createPost')

  const content = String(request.data?.content ?? '').trim()
  if (content.length < 4) throw new HttpsError('invalid-argument', 'Post is too short.')
  if (content.length > 600) throw new HttpsError('invalid-argument', 'Post is too long.')

  const category = String(request.data?.category ?? 'General')
  if (!POST_CATEGORIES.has(category)) {
    throw new HttpsError('invalid-argument', 'Unknown category.')
  }

  const projectIdRaw = request.data?.projectId
  const projectId =
    typeof projectIdRaw === 'string' && projectIdRaw.length <= 80 ? projectIdRaw : null

  const imageRaw = request.data?.imageData
  let imageData: string | null = null
  if (typeof imageRaw === 'string' && imageRaw.length > 0) {
    if (imageRaw.length > MAX_IMAGE_CHARS) {
      throw new HttpsError('invalid-argument', 'Image is too large — please retake it.')
    }
    if (!IMAGE_DATA_URI.test(imageRaw)) {
      throw new HttpsError('invalid-argument', 'Unsupported image format.')
    }
    imageData = imageRaw
  }

  // Identity comes from the verified token — NEVER from the client payload.
  const token = request.auth.token as { name?: string; picture?: string }

  const ref = await db.collection('posts').add({
    authorId: uid,
    authorName: token.name?.slice(0, 60) || 'Explorer',
    authorPhotoURL: token.picture ?? null,
    content,
    category,
    projectId,
    imageData,
    status: 'active',
    upvotes: 0,
    downvotes: 0,
    reports: 0,
    score: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  })

  logger.info('Post created', { postId: ref.id, uid })
  return { id: ref.id }
})

type VoteValue = 1 | -1 | 0

function toVoteValue(vote: unknown): VoteValue {
  if (vote === 'up') return 1
  if (vote === 'down') return -1
  return 0
}

function evaluateStatus(upvotes: number, downvotes: number, reports: number) {
  const score = upvotes - downvotes - reports * 2

  if (reports >= 6 || score <= -12) {
    return { score, status: 'hidden' as const }
  }

  if (reports >= 3 || score <= -4) {
    return { score, status: 'limited' as const }
  }

  return { score, status: 'active' as const }
}

// Vote/report math must never lift an AI moderation verdict stored on the post.
function statusFromAiVerdict(postData: { moderation?: { verdict?: string | null } }): PostStatus {
  const verdict = postData.moderation?.verdict
  if (verdict === 'harmful') return 'hidden'
  if (verdict === 'questionable') return 'limited'
  return 'active'
}

export const votePost = onCall(CALLABLE_OPTS, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be logged in to vote.')
  }
  await enforceRateLimit(request.auth.uid, 'vote')

  const uid = request.auth.uid

  const postId = String(request.data?.postId ?? '').trim()
  const vote = toVoteValue(request.data?.vote)

  if (!postId) {
    throw new HttpsError('invalid-argument', 'postId is required.')
  }

  const postRef = db.collection('posts').doc(postId)
  const voteRef = postRef.collection('votes').doc(uid)

  await db.runTransaction(async (transaction) => {
    const postSnap = await transaction.get(postRef)
    if (!postSnap.exists) {
      throw new HttpsError('not-found', 'Post not found.')
    }

    const postData = postSnap.data() as {
      upvotes?: number
      downvotes?: number
      reports?: number
      moderation?: { verdict?: string | null }
    }

    const voteSnap = await transaction.get(voteRef)
    const previousVote = voteSnap.exists ? Number(voteSnap.data()?.value ?? 0) : 0

    let upvotes = Number(postData.upvotes ?? 0)
    let downvotes = Number(postData.downvotes ?? 0)

    if (previousVote === 1) upvotes = Math.max(0, upvotes - 1)
    if (previousVote === -1) downvotes = Math.max(0, downvotes - 1)

    if (vote === 1) upvotes += 1
    if (vote === -1) downvotes += 1

    const reports = Number(postData.reports ?? 0)
    const moderated = evaluateStatus(upvotes, downvotes, reports)

    transaction.update(postRef, {
      upvotes,
      downvotes,
      score: moderated.score,
      status: worstStatus(moderated.status, statusFromAiVerdict(postData)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    if (vote === 0) {
      transaction.delete(voteRef)
    } else {
      transaction.set(
        voteRef,
        {
          uid,
          value: vote,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
    }
  })

  return { ok: true }
})

export const reportPost = onCall(CALLABLE_OPTS, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be logged in to report.')
  }
  await enforceRateLimit(request.auth.uid, 'report')

  const uid = request.auth.uid

  const postId = String(request.data?.postId ?? '').trim()
  const reason = String(request.data?.reason ?? '').trim().slice(0, 200)

  if (!postId) {
    throw new HttpsError('invalid-argument', 'postId is required.')
  }

  if (reason.length < 4) {
    throw new HttpsError('invalid-argument', 'Please provide a valid report reason.')
  }

  const postRef = db.collection('posts').doc(postId)
  const reportRef = postRef.collection('reports').doc(uid)

  await db.runTransaction(async (transaction) => {
    const postSnap = await transaction.get(postRef)
    if (!postSnap.exists) {
      throw new HttpsError('not-found', 'Post not found.')
    }

    const reportSnap = await transaction.get(reportRef)
    if (reportSnap.exists) {
      throw new HttpsError('already-exists', 'You already reported this post.')
    }

    const postData = postSnap.data() as {
      upvotes?: number
      downvotes?: number
      reports?: number
      moderation?: { verdict?: string | null }
    }

    const upvotes = Number(postData.upvotes ?? 0)
    const downvotes = Number(postData.downvotes ?? 0)
    const reports = Number(postData.reports ?? 0) + 1

    const moderated = evaluateStatus(upvotes, downvotes, reports)

    transaction.set(reportRef, {
      uid,
      reason,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    transaction.update(postRef, {
      reports,
      score: moderated.score,
      status: worstStatus(moderated.status, statusFromAiVerdict(postData)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  })

  return { ok: true }
})

// Fallback heuristic, used only if the AI moderation call fails (word-boundary
// match so "skill"/"class" don't trip it). Deliberately conservative: flags as
// 'limited' for human eyes, never auto-hides.
const blockedWordPattern =
  /\b(kill|killing|murder|rape|bomb|shoot|stab|lynch|behead|terror|terrorist|hate|abuse|slut|whore|bitch|bastard|chutiya|madarchod|behenchod|randi|harami|kamina|die|death threat)\b/i

type PostStatus = 'active' | 'limited' | 'hidden'
const statusSeverity: Record<PostStatus, number> = { active: 0, limited: 1, hidden: 2 }

function worstStatus(a: PostStatus, b: PostStatus): PostStatus {
  return statusSeverity[a] >= statusSeverity[b] ? a : b
}

export const moderatePostOnCreate = onDocumentCreated(
  {
    region: 'asia-south1',
    document: 'posts/{postId}',
    secrets: [geminiApiKey],
    timeoutSeconds: 120,
  },
  async (event) => {
    const snapshot = event.data
    if (!snapshot) return

    const data = snapshot.data() as {
      content?: string
      status?: string
      upvotes?: number
      downvotes?: number
      reports?: number
    }

    const content = String(data.content ?? '')

    const upvotes = Number(data.upvotes ?? 0)
    const downvotes = Number(data.downvotes ?? 0)
    const reports = Number(data.reports ?? 0)
    const moderated = evaluateStatus(upvotes, downvotes, reports)
    const voteStatus = (data.status ?? moderated.status) as PostStatus

    // Primary path: Claude content classification. Fallback: word list.
    let aiStatus: PostStatus = 'active'
    let aiVerdict: string | null = null
    let aiReason: string | null = null
    let aiCategories: string[] = []

    try {
      const result = await moderateContent(content)
      aiVerdict = result.verdict
      aiReason = result.reason
      aiCategories = result.categories
      aiStatus =
        result.verdict === 'harmful' ? 'hidden' : result.verdict === 'questionable' ? 'limited' : 'active'
    } catch (error) {
      logger.warn('Claude moderation unavailable, using word-list fallback', {
        postId: snapshot.id,
        error: error instanceof Error ? error.message : String(error),
      })
      if (blockedWordPattern.test(content)) aiStatus = 'limited'
    }

    const status = worstStatus(aiStatus, voteStatus)

    await snapshot.ref.set(
      {
        status,
        score: moderated.score,
        upvotes,
        downvotes,
        reports,
        moderation: {
          verdict: aiVerdict,
          reason: aiReason,
          categories: aiCategories,
        },
        moderatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    logger.info('Post moderation evaluated', {
      postId: snapshot.id,
      status,
      score: moderated.score,
      aiVerdict,
    })
  },
)

// ---------------------------------------------------------------------------
// Leaderboard — real ranking over users (admin SDK; user docs are owner-only
// readable from the client, so ranking has to happen server-side).
// Progression math mirrors web/src/lib/progression.ts.
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000 // users are Delhi-based

function istDayKey(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function computeStreak(exploredAt: Record<string, unknown>): number {
  const days = new Set<string>()
  for (const iso of Object.values(exploredAt ?? {})) {
    const t = Date.parse(String(iso))
    if (!Number.isNaN(t)) days.add(istDayKey(t))
  }
  if (days.size === 0) return 0

  let cursor = Date.now()
  const DAY_MS = 24 * 60 * 60 * 1000
  // grace: streak survives if the last exploration was yesterday
  if (!days.has(istDayKey(cursor))) {
    cursor -= DAY_MS
    if (!days.has(istDayKey(cursor))) return 0
  }
  let streak = 0
  while (days.has(istDayKey(cursor))) {
    streak++
    cursor -= DAY_MS
  }
  return streak
}

function computeXP(exploredIds: string[], categoryById: Map<string, string>): number {
  const counts = new Map<string, number>()
  let n = 0
  for (const id of exploredIds) {
    const category = categoryById.get(id)
    if (!category) continue
    counts.set(category, (counts.get(category) ?? 0) + 1)
    n++
  }
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / Math.max(1, n)
    if (p > 0) entropy -= p * Math.log2(p)
  }
  const diversity = 1 + 0.5 * Math.min(1, entropy / Math.log2(7))
  return Math.round(exploredIds.length * 50 * diversity)
}

function levelFromXP(xp: number): number {
  let level = 1
  while (Math.round((200 * (Math.pow(1.35, level) - 1)) / 0.35) <= xp) level++
  return level
}

export const getLeaderboard = onCall(CALLABLE_OPTS, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to view the leaderboard.')
  }
  await enforceRateLimit(request.auth.uid, 'leaderboard')

  const snapshot = await db
    .collection('users')
    .orderBy('exploredCount', 'desc')
    .limit(10)
    .get()

  const categoryById = new Map(enhancedProjects.map((p) => [p.id, p.category]))

  const entries = snapshot.docs
    .map((docSnap) => {
      const data = docSnap.data()
      const ids: string[] = Array.isArray(data.exploredProjectIds)
        ? data.exploredProjectIds.filter((id: unknown): id is string => typeof id === 'string')
        : []
      const xp = computeXP(ids, categoryById)
      return {
        name:
          typeof data.displayName === 'string' && data.displayName.trim()
            ? data.displayName.trim()
            : 'Explorer',
        explored: ids.length,
        xp,
        level: levelFromXP(xp),
        streak: computeStreak(data.exploredAt ?? {}),
        isYou: docSnap.id === request.auth?.uid,
      }
    })
    .filter((entry) => entry.explored > 0)

  return { entries }
})

// Note: the old HuggingFace enhanceProjectDescription callable was replaced by
// generateProjectInsight in ./ai (Claude structured outputs, Firestore-cached).
