// Per-user rate limiting for the expensive callables.
//
// WHY: the Firebase web config is public by design, so anyone can sign in with
// a throwaway account and hammer askCivicAssistant / discoverProjectsNear from
// a script. That would (a) exhaust the shared Gemini free-tier quota, killing
// the AI for every real user, and (b) bill Cloud Run against the project's
// credits. App Check raises the bar; this puts a hard ceiling behind it.
//
// Fixed-window counters in Firestore, one doc per user+action per window.
// Docs carry `expiresAt` so the Firestore TTL policy sweeps them (see
// storage-lifecycle). Fail-open on infrastructure errors: a broken limiter
// must not take the app down with it.

import { HttpsError } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import * as admin from 'firebase-admin'

const COLLECTION = 'rateLimits'

export interface Limit {
  /** Max calls allowed inside the window. */
  max: number
  /** Window length in seconds. */
  windowSec: number
}

/** Budgets are sized so a normal user never notices, but a script dies fast. */
export const LIMITS = {
  // Each chat turn can burn 2-4 Gemini calls (tool loop) — the scarcest resource
  assistant: { max: 60, windowSec: 24 * 60 * 60 },
  // One Gemini call + Nominatim geocoding + several Overpass crawls per run
  deepScan: { max: 25, windowSec: 24 * 60 * 60 },
  // Gemini structured output, cached in Firestore afterwards
  insight: { max: 40, windowSec: 24 * 60 * 60 },
  // No LLM — pure vector retrieval, so it can be generous
  semanticSearch: { max: 300, windowSec: 24 * 60 * 60 },
  // Each post triggers a moderation call; also the main spam vector
  createPost: { max: 15, windowSec: 60 * 60 },
  // Cheap Firestore transactions, but still worth a ceiling
  vote: { max: 300, windowSec: 60 * 60 },
  report: { max: 20, windowSec: 24 * 60 * 60 },
  leaderboard: { max: 120, windowSec: 60 * 60 },
} as const satisfies Record<string, Limit>

export type LimitedAction = keyof typeof LIMITS

/**
 * PROJECT-WIDE daily ceiling on AI calls, across every user.
 *
 * Per-user limits alone don't protect the Gemini quota: it is shared by the
 * whole project, so N throwaway accounts each staying under their own budget
 * can still collectively drain it and break the AI for real users. (App Check
 * is the proper fix for scripted abuse; this is the safety net that works
 * without it — and a useful backstop even with it.)
 *
 * Sized under the free-tier daily allowance, leaving headroom for moderation
 * (which is triggered by posts, not by callables, and must never be starved).
 */
const GLOBAL_AI_BUDGET = 600

/**
 * Consume one unit of the shared AI budget.
 * Returns false when the project's daily allowance is spent — callers should
 * DEGRADE GRACEFULLY (skip the AI step) rather than fail the whole request.
 */
export async function consumeGlobalAiBudget(label: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
  const ref = admin.firestore().collection(COLLECTION).doc(`global_ai_${day}`)

  try {
    return await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const count = snap.exists ? Number(snap.data()?.count ?? 0) : 0

      if (count >= GLOBAL_AI_BUDGET) {
        logger.error('Project-wide AI budget exhausted for today', {
          label,
          count,
          budget: GLOBAL_AI_BUDGET,
        })
        return false
      }

      tx.set(
        ref,
        {
          scope: 'global-ai',
          day,
          count: count + 1,
          expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3 * 24 * 60 * 60 * 1000),
        },
        { merge: true },
      )
      return true
    })
  } catch (error) {
    // Fail open: a broken counter must not disable the AI.
    logger.warn('Global AI budget check failed — allowing', {
      label,
      error: error instanceof Error ? error.message : String(error),
    })
    return true
  }
}

/**
 * Consume one unit of the user's budget for `action`.
 * Throws HttpsError('resource-exhausted') when the budget is spent.
 */
export async function enforceRateLimit(uid: string, action: LimitedAction): Promise<void> {
  const limit: Limit = LIMITS[action]
  const windowMs = limit.windowSec * 1000
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs
  const docId = `${uid}_${action}_${windowStart}`
  const ref = admin.firestore().collection(COLLECTION).doc(docId)

  try {
    await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const count = snap.exists ? Number(snap.data()?.count ?? 0) : 0

      if (count >= limit.max) {
        throw new HttpsError(
          'resource-exhausted',
          `Daily limit reached for this feature (${limit.max}). It resets soon — thanks for understanding!`,
        )
      }

      tx.set(
        ref,
        {
          uid,
          action,
          count: count + 1,
          windowStart,
          // Swept by the Firestore TTL policy on `expiresAt`
          expiresAt: admin.firestore.Timestamp.fromMillis(windowStart + windowMs * 2),
        },
        { merge: true },
      )
    })
  } catch (error) {
    // A real limit breach must propagate...
    if (error instanceof HttpsError) throw error
    // ...but an infrastructure hiccup must not break the feature (fail open).
    logger.warn('Rate limiter unavailable — allowing the request', {
      uid,
      action,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
