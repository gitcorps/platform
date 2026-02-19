# GitCorps MVP Setup Guide

This document explains how to configure and run the GitCorps MVP implemented in this repository.

## 1. Repository Structure

- `functions/`: Firebase Cloud Functions backend (orchestration, GitHub, Stripe hooks)
- `apps/web/`: Next.js frontend (`/`, `/new`, `/p/[slug]`)
- `tools/gitcorps_runner.mjs`: Repo-local runner entrypoint used by project repos
- `tools/agent-runner/`: TypeScript runner abstraction package (provider/runtime adapters + tests)
- `.github/workflows/gitcorps-agent.yml`: Required agent workflow contract

## 2. Prerequisites

- Node.js 20+
- Firebase CLI (`npm i -g firebase-tools`)
- A Firebase project (Blaze plan required for Stripe extension + Functions + scheduled functions)
- A GitHub org (default expected: `gitcorps`, configurable)
- A GitHub bot/app token with org repo admin permissions
- A Stripe account

## 3. Firebase Project Setup

### 3.1 Create and Link Project

1. Create a Firebase project in console.
2. In repo root, set `.firebaserc` default project id.
3. Authenticate CLI: `firebase login`.
4. Verify: `firebase projects:list`.

### 3.2 Enable Products

Enable in Firebase console:

1. Authentication
2. Firestore (Native mode)
3. Cloud Functions
4. Hosting (web frameworks)

### 3.3 Authentication Setup

1. Enable at least one human sign-in method (Google recommended).
2. Add your web app to Firebase project.
3. Copy web config values for frontend env (see Section 8).

### 3.4 Firestore Rules/Indexes

From repo root:

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Rules allow:

- Public read for `projects`, run history, funding history.
- Authenticated users to create Stripe checkout session docs in `customers/{uid}/checkout_sessions`.
- Writes to project/run/funding ledger docs only from backend admin SDK.

## 4. Stripe Extension Setup (Firestore Stripe Payments)

This implementation uses the Firebase Stripe extension collections/events:

- Checkout sessions: `customers/{uid}/checkout_sessions/{sessionId}`
- Payments: `customers/{uid}/payments/{paymentIntentId}`

### 4.1 Install Extension

1. Install **Run Payments with Stripe** (official `firestore-stripe-payments`) in Firebase Extensions.
2. Configure extension for one-time Checkout payments.
3. Ensure webhook endpoint is active in Stripe dashboard (the extension manages this).

### 4.2 Checkout to Project Wallet Mapping

The backend maps a successful payment to a project wallet via this flow:

1. `createFundingCheckoutSession` callable writes checkout session doc with `metadata.projectId`.
2. Callable also writes `payment_intent_data.metadata.projectId` to improve propagation to payment records.
3. Backend writes `checkoutSessionProjects/{sessionId}` mapping.
4. `onCheckoutSessionUpdated` stores `paymentIntentProjects/{paymentIntentId}` once `payment_intent` appears.
5. `onStripePaymentSucceeded` (document write trigger, not create-only) processes the first transition to succeeded/paid, credits `projects/{projectId}.balanceCents`, writes `fundingEvents/{paymentIntentId}` idempotently, then calls `maybeStartRun(projectId)`.
6. If project mapping is not ready yet, payment is staged in `pendingStripePayments/{paymentIntentId}` and retried when mapping arrives (`onPaymentIntentProjectMapped`) and by scheduled backstop (`retryPendingStripePayments`).

Security guard: checkout `successUrl` and `cancelUrl` are allowlisted to `PUBLIC_SITE_DOMAIN` (or localhost for dev) by backend callable validation.

Assumption: extension payment docs include either metadata or a linkable payment intent/session id. This is covered by fallback mapping docs above.

## 5. GitHub Org and Bot/App Setup

### 5.1 GitHub Org

- Default org expected by spec: `gitcorps`
- Configurable with env var `GITHUB_ORG_NAME`

### 5.2 Bot Token / GitHub App Permissions

Use either a GitHub App installation token flow or a bot PAT. For MVP this code expects `GITHUB_TOKEN`.

Required permissions:

- Create repos in org
- Push contents to repos
- Manage Actions workflow dispatch

At minimum ensure rights to:

- `repo` (public_repo is sufficient for public-only org)
- `workflow`
- org repo creation permissions

### 5.3 Project Repo Seeding

`createProject` callable creates a public repo and seeds:

- `VISION.md`
- `STATUS.md`
- `.github/workflows/gitcorps-agent.yml`
- `tools/gitcorps_runner.mjs`
- `LICENSE`

## 6. GitHub Org Secrets / Variables

For project repositories (or org-wide defaults), set:

Secrets:

- `OPENAI_API_KEY` (optional if using Anthropic only)
- `ANTHROPIC_API_KEY` (optional if using OpenAI only)

Variables:

- `LLM_PROVIDER_DEFAULT` (`openai` or `anthropic`)
- `LLM_MODEL_DEFAULT` (e.g. `gpt-4.1`, `claude-3-5-sonnet-latest`)
- `OPENAI_BASE_URL` (optional OpenAI-compatible endpoint)
- `ANTHROPIC_BASE_URL` (optional Anthropic-compatible endpoint)

Notes:

- The workflow is BYOK-capable for OpenAI-compatible and Anthropic-compatible APIs.
- OpenAI-compatible runner attempts `/responses` first, then `/chat/completions` for compatibility.
- For OpenAI-compatible models that reject chat parameters (for example some codex/reasoning models), runner uses minimal Responses API payload (`model`, `instructions`, `input`) without `temperature`.
- If provider calls fail (missing key, invalid model, or endpoint mismatch), runner falls back to heuristic mode and still updates `STATUS.md`.

## 7. Backend Environment Configuration

This project uses **Cloud Functions Gen2** and reads configuration from `process.env`.

Important:

- `firebase functions:config:set` is a Gen1 runtime-config mechanism and is **not** the primary config path for this codebase.
- `functions:config:set` keys are lowercase/dotted, so uppercase names like `GITHUB_TOKEN` fail there.
- For this project, use dotenv files under `functions/` (supported by Firebase CLI for Gen2 deploy/emulator).

### 7.1 Recommended Gen2 config method

1. Copy `/Users/jbraunschweiger/Development/platform/functions/.env.example` to:
   - `/Users/jbraunschweiger/Development/platform/functions/.env` for local emulator use
   - `/Users/jbraunschweiger/Development/platform/functions/.env.<projectId>` for project-specific deploy values
2. Fill in values.
3. Deploy functions normally.

Required/important keys:

- `GITHUB_TOKEN`
- `GITHUB_ORG_NAME` (default `gitcorps`)
- `PUBLIC_SITE_DOMAIN` (default `gitcorps.com`)
- `PROJECT_SITE_TEMPLATE` (default `{slug}.gitcorps.com`)
- `DEFAULT_LICENSE` (default `MIT`)
- `MIN_RUN_USD`
- `MAX_RUN_USD`
- `GLOBAL_MAX_CONCURRENT_RUNS`
- `GLOBAL_MAX_DAILY_SPEND_USD`
- `PER_PROJECT_MAX_DAILY_SPEND_USD`
- `LLM_PROVIDER_DEFAULT`
- `LLM_MODEL_DEFAULT`
- `AGENT_RUNTIME_DEFAULT`
- `BACKEND_BASE_URL` (must point to deployed Functions base URL)
- `BUCKET_RUNTIME_MINUTES_PER_USD`
- `BUCKET_TOKENS_PER_USD`

Example base URL format:

`https://us-central1-<firebase-project-id>.cloudfunctions.net`

### 7.2 Verify GitHub token/org access (preflight callable)

After deploying functions, verify GitHub repo-creation access before testing project creation:

1. Open your deployed web app in a browser.
2. Open DevTools Console.
3. Run this snippet (replace Firebase config values):

```js
const { initializeApp } = await import("https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js");
const { getAuth, GoogleAuthProvider, signInWithPopup } = await import("https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js");
const { getFunctions, httpsCallable } = await import("https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js");

const app = initializeApp({
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_APP_ID",
}, "preflight-check");

const auth = getAuth(app);
if (!auth.currentUser) {
  await signInWithPopup(auth, new GoogleAuthProvider());
}

const functions = getFunctions(app, "us-central1");
const callPreflight = httpsCallable(functions, "githubPreflight");
const result = await callPreflight({});
console.log(result.data);
```

4. Interpret the response:
   - `ok: true` and `repoCreateHeuristic: "likely"` means token/org access looks ready.
   - `errors` with `step: "org"` or `step: "viewer"` usually means bad token permissions/SSO/org access.
   - `membership.state !== "active"` means org invitation not accepted.
   - `orgSettings.membersCanCreateRepositories: false` with non-admin membership means org policy blocks repo creation.

## 8. Frontend Environment Variables

Create `apps/web/.env.local`:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION=us-central1
```

## 9. Install, Build, Run Locally

From repo root:

```bash
npm install
```

Run frontend:

```bash
npm run dev:web
```

Run Firebase emulators for functions/firestore:

```bash
npm run dev:functions
```

Run tests:

```bash
npm run test
```

## 10. Deploy

### 10.1 Deploy Functions + Firestore + Hosting

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

### 10.2 Verify Function URLs

Confirm deployed URLs for:

- `runStarted`
- `runHeartbeat`
- `runFinished`

Set `BACKEND_BASE_URL` accordingly and redeploy Functions if needed.

## 11. Full End-to-End Verification

1. Open web app `/new`.
2. Sign in.
3. Create project with manifesto and non-zero initial funding.
4. Confirm redirect to Stripe Checkout.
5. Complete payment.
6. Confirm:
   - project balance increased (`projects/{projectId}.balanceCents`)
   - funding event created (`projects/{projectId}/fundingEvents/{paymentIntentId}`)
   - no stuck doc in `pendingStripePayments/{paymentIntentId}` (or it is cleared within a few minutes)
7. Confirm orchestrator created a queued run and set `currentRunId`.
8. Confirm GitHub Actions workflow dispatched in created repo.
9. Confirm workflow calls:
   - `runStarted`
   - `runHeartbeat`
   - `runFinished`
10. Confirm project repo updated:
   - `STATUS.md` appended with run section
   - commit landed on `main`
11. Confirm backend cleared `currentRunId`, deducted run spend, and auto-continued if balance remained above `MIN_RUN_USD`.

## 12. Operational Notes and Assumptions

- If workflow dispatch fails or a queued run never starts, backend auto-requeues via scheduled recovery.
- Before each dispatch, backend syncs `.github/workflows/gitcorps-agent.yml` and `tools/gitcorps_runner.mjs` in the project repo to keep existing repos on latest runtime/workflow fixes.
- If Stripe mapping/ordering is delayed, backend stages unresolved payments in `pendingStripePayments` and retries automatically.
- Queue is FIFO using `runQueue` ordered by `enqueuedAt`.
- Per-project concurrency is enforced via `projects.currentRunId` and `activeRuns/{projectId}`.
- Daily spend caps are enforced from today’s `runs.chargedCents` totals.
- Bucket model consumes run budget at `runFinished` using reported spend capped by budget.
- Project slug uniqueness is enforced atomically via `projectSlugs/{slug}` reservation docs.
- Stale running runs (heartbeat timeout) are auto-failed and requeued by scheduler.
- License defaults to MIT.

### 12.1 If Wallet Credits But No Run Starts

Check these in order:

1. Function logs for `maybeStartRun evaluated after funding event`:
   - `runResult.state: "started"` means run was dispatched.
   - `runResult.state: "queue_enqueued"` means queued due cap/concurrency gate.
   - `runResult.state: "skipped"` with `gateReason: "insufficient_balance"` means wallet is below `MIN_RUN_USD`.
2. Confirm env thresholds:
   - `MIN_RUN_USD` default is `2`.
   - If funding is less than `$2.00`, no run is queued by design.
3. Confirm orchestrator dispatch prerequisites:
   - `BACKEND_BASE_URL` must be set.
   - `projects/{projectId}.repoFullName` must exist.
4. Manual nudge for diagnostics:
   - Call callable `maybeStartRunCallable` with `{ projectId }` and inspect returned `state`/`gateReason`.
5. Firestore precondition warnings:
   - `FAILED_PRECONDITION` from orchestrator queries indicates missing Firestore indexes (especially collection-group indexes on `runs.status` and `runs.endedAt`).
   - Deploy indexes with `firebase deploy --only firestore:indexes`.
   - Wait until index build completes in Firebase Console before re-testing.

## 13. Known TODOs / Credential-Dependent Areas

- Production-grade GitHub App JWT flow is not implemented; MVP uses `GITHUB_TOKEN` directly.
- Stripe tax/shipping/refund handling is intentionally out of scope for MVP.
- Provider-specific rate limiting/retry backoff in runner can be hardened for production.
