// Shared callable configuration: App Check + cost caps.
//
// APP CHECK — the Firebase web config ships in the JS bundle (by design), so a
// valid auth token is NOT proof the call came from our app. App Check attests
// the *client* (reCAPTCHA v3 in the browser) and blocks scripted abuse of the
// AI callables, which is what protects the shared Gemini quota.
//
// Enforcement is behind an env flag so it can be rolled out safely:
//   1. deploy with APP_CHECK_ENFORCED unset → tokens are collected and logged,
//      nothing is blocked (monitor mode; existing clients keep working)
//   2. register reCAPTCHA v3 in the Firebase console and set the site key in
//      web/.env as VITE_RECAPTCHA_SITE_KEY
//   3. set APP_CHECK_ENFORCED=true in functions/.env and redeploy → enforced
//
// MAX INSTANCES — a hard ceiling on concurrent instances. Without it, a runaway
// client (or a retry storm) can scale out and bill real money against the GCP
// credits. These functions are for a civic app in one city; 5-10 is plenty.

import type { CallableOptions } from 'firebase-functions/v2/https'

export const REGION = 'asia-south1'

export const APP_CHECK_ENFORCED = process.env.APP_CHECK_ENFORCED === 'true'

/** Baseline for cheap callables (votes, reports, posts, leaderboard). */
export const CALLABLE_OPTS: CallableOptions = {
  region: REGION,
  enforceAppCheck: APP_CHECK_ENFORCED,
  maxInstances: 10,
}

/**
 * For callables that spend scarce resources (Gemini quota, Chroma, Overpass,
 * Nominatim). Tighter instance cap: these should queue, never fan out.
 */
export const EXPENSIVE_CALLABLE_OPTS: CallableOptions = {
  region: REGION,
  enforceAppCheck: APP_CHECK_ENFORCED,
  maxInstances: 5,
}
