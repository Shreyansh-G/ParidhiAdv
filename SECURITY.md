# Security

## The thing everything else follows from

The Firebase web config is public by design. It ships inside the JavaScript bundle, and anybody can
open devtools and read it. That means a valid auth token proves *a user exists*. It does not prove
that *my app* made the request.

So anyone can sign in with a throwaway Google account and call my backend from a script. Once you
accept that, the rest of this document more or less writes itself.

There are two things actually worth protecting:

**The Gemini quota.** It's shared across the whole project, not per user. One abuser exhausts the AI
for everyone. This isn't hypothetical — it happened to me once, back when the model alias I was
using turned out to have a 20-request-a-day limit.

**The bill.** Cloud Run scales out happily. An unbounded caller costs real money.

## What's in place

| Layer | What it does | Where |
|---|---|---|
| Auth | Every callable needs a signed-in user | all `onCall`s |
| App Check | Attests the call came from the real app, not a script | `functions/src/appCheck.ts` |
| Rate limits | Per-user daily and hourly budgets | `functions/src/rateLimit.ts` |
| `maxInstances` | A ceiling on concurrency is a ceiling on cost | 5 for AI, 10 for the rest |
| Server-owned writes | Posts, votes and reports are written *only* by functions | `firestore.rules` |
| Guardrails | Model output is validated before it can reach the map | `discoveryAgent.mergeValidate` |
| Prompt fencing | Untrusted text is delimited and declared as data | `discoveryAgent.extract` |
| TTL policies | Nothing grows forever | every cache carries `expiresAt` |

### The rate limits

| Action | Budget | Why that number |
|---|---|---|
| `assistant` | 60/day | each chat turn burns 2–4 Gemini calls |
| `deepScan` | 25/day | one Gemini call, plus geocoding and Overpass crawls |
| `insight` | 40/day | structured output, then cached |
| `semanticSearch` | 300/day | no model involved, so it can be generous |
| `createPost` | 15/hour | every post triggers a moderation call |
| `vote` | 300/hour | cheap, but still worth bounding |

The limiter **fails open**. If Firestore itself is broken, requests go through rather than taking the
whole app down with them. A genuine breach returns `resource-exhausted`.

## Why posts are written on the server

They didn't used to be. The browser wrote straight to Firestore, and that was a mistake for three
reasons.

`authorName` was whatever the client claimed it was. Nothing stopped you posting as "Delhi Municipal
Corporation ✓". It now comes from the verified auth token, so it can't be forged.

There was no way to rate-limit anything, which meant a spammer could burn the entire AI moderation
quota.

And `imageData` was unvalidated beyond a size check. Now it has to match
`data:image/(webp|jpeg|png);base64,…`.

`createPost` is a callable function and `firestore.rules` refuses client creates outright, so there's
no way around it.

## The project-wide AI budget

This is the one I got wrong at first, and it's worth explaining properly.

Per-user rate limits do **not** protect the Gemini quota, because that quota belongs to the project,
not to any individual. Twenty throwaway Google accounts, each politely staying inside its own limit,
can still collectively drain it and break the AI for everybody who's actually using the app.

So `consumeGlobalAiBudget()` caps AI calls across *all* users at 600 a day. When that's spent,
features degrade instead of failing:

| Feature | What happens when the budget's gone |
|---|---|
| Deep Scan | still returns every OpenStreetMap result; only news discovery is skipped |
| Project insights | falls back to the bundled heuristic |
| Assistant | says "back tomorrow"; search and the map are untouched |
| Moderation | **not counted against the budget at all** — safety should never be the thing that runs out |

Like the per-user limiter, it fails open. A broken counter never disables the AI.

## App Check is deferred, on purpose

App Check is currently in monitor mode, and reCAPTCHA isn't set up. That's a considered trade-off
rather than an oversight, so here's the honest accounting.

Rate limits, the global AI budget and `maxInstances` bound the damage. What remains exposed is that
someone determined, with a lot of throwaway Google accounts, could still consume the shared AI budget
and deny the AI to real users for a day. They *cannot* run up a bill, forge an identity, or fake
votes.

For a prototype being tested in one village, that attacker doesn't exist. Before any public launch,
turning it on takes four steps:

1. Firebase console → App Check → Apps → register the web app with reCAPTCHA v3, and copy the site
   key.
2. Put it in `web/.env` as `VITE_RECAPTCHA_SITE_KEY`. For local development, add a debug token under
   App Check → Manage debug tokens and set `VITE_APPCHECK_DEBUG_TOKEN`.
3. Set `APP_CHECK_ENFORCED=true` in `functions/.env`.
4. Rebuild and redeploy.

Rate limits are real protection. But App Check is what stops abuse from ever reaching the function in
the first place.

## Dependency audit

Every package in the repo — `web/`, `functions/` and the root — is at **zero vulnerabilities**.

Getting `functions/` there was more interesting than it should have been, and the process is worth
recording because the obvious answers were all wrong.

It started with eight moderate advisories, all tracing back to one package: `uuid@9.0.1`, pulled in
transitively by `firebase-admin` through `google-gax`, `gaxios` and `teeny-request`.

**npm's suggested fix was to upgrade `firebase-admin` to v14.** I tried it. Two problems: v14 removes
the `admin.firestore` namespace this codebase uses, so the build fails outright — *and it doesn't
even fix the bug*, because v14 still depends on `@google-cloud/storage@7.21.0`, which still pulls
`uuid@9.0.1`. It took the count from eight to seven. After that, npm's next suggestion was
`firebase-admin@10.3.0`, which is a **downgrade**. At that point it's obvious the tool is guessing.

So there is no version of `firebase-admin` that fixes this. The only real fix is to override the
transitive dependency directly:

```json
"overrides": { "uuid": "^11.1.1" }
```

Overriding a transitive dependency is normally reckless — it can break a package at *runtime*, where
TypeScript can't warn you. So before doing it I checked what those packages actually call:

```
uuid.v4()        ← the only call, anywhere
v3 / v5 / v6     ← never called, by anything
```

The API surface in use is a single function, and `v4()` is unchanged between uuid 9 and 11. I then
verified the override end-to-end rather than assuming: `uuid@11.1.1` still ships a CommonJS build with
a `require` export condition, `require('uuid')` resolves, `v4()` returns a valid UUID, and
`firebase-admin`, `gaxios`, `google-gax` and `teeny-request` all still load and work.

The lesson I'd take from this one: `npm audit fix --force` would have downgraded a core dependency and
broken the build, to fix nothing. Understanding *which functions you actually call* is what made a
safe fix possible.

One other find along the way — `firebase-admin` was also sitting in the **root** `package.json` as a
dead dependency that nothing imported. Removing it took the root from eight advisories to zero on its
own.

## Risks I've accepted

**Posts are publicly readable**, images included. That's intended — it's a public civic feed.

**The leaderboard shows display names** of the top ten explorers. Also intended, though there's no
opt-out yet.

**Chroma on Cloud Run is `--allow-unauthenticated` behind a bearer token.** If the token leaked,
someone could read the vector database. It contains only public project data, no user data. The
hardening path is to switch to IAM `roles/run.invoker` for the functions' service account.

**Google News RSS is scraped with no API contract.** It could change or block me at any time. Deep
Scan degrades to its OpenStreetMap half if that happens.
