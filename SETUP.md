# GitCorps MVP Setup Guide

This guide covers the implemented MVP architecture:

- Firebase Functions orchestrate when runs start.
- GitHub Actions executes each run.
- The run executes GitHub Copilot CLI loop (`copilot --prompt`) in Actions.
- Backend callbacks (`runStarted`, `runHeartbeat`, `runFinished`) track lifecycle and budget.

## 1. Repository Layout

- `/Users/jbraunschweiger/Development/platform/functions`: Firebase Functions (orchestrator, GitHub, Stripe hooks).
- `/Users/jbraunschweiger/Development/platform/apps/web`: Next.js frontend (`/`, `/new`, `/p/[slug]`).
- `/Users/jbraunschweiger/Development/platform/functions/src/templates/workflow.ts`: seeded workflow template.
- `/Users/jbraunschweiger/Development/platform/functions/src/templates/runner.ts`: seeded runner entrypoint (`tools/gitcorps_runner.mjs`).
- `/Users/jbraunschweiger/Development/platform/functions/src/templates/agent.ts`: seeded Copilot custom-agent instructions (`.github/agents/gitcorps.agent.md`).

## 2. Prerequisites

- Node.js 20+
- Firebase CLI
- Firebase project on Blaze plan
- GitHub org (default `gitcorps`, configurable)
- Stripe account
- GitHub Copilot coding agent enabled for your org/repositories

## 3. Firebase Setup

### 3.1 Create and Link Project

1. Create Firebase project.
2. Set `.firebaserc` default project.
3. Run `firebase login`.
4. Verify `firebase projects:list`.

### 3.2 Enable Products

Enable:

1. Authentication
2. Firestore (Native mode)
3. Cloud Functions
4. Hosting

### 3.3 Deploy Firestore Rules and Indexes

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

## 4. Functions Environment (Gen2-Safe)

Do not use Gen1 `functions:config:set` for this codebase.

Use dotenv files:

1. Copy `/Users/jbraunschweiger/Development/platform/functions/.env.example` to:
   - `/Users/jbraunschweiger/Development/platform/functions/.env`
   - `/Users/jbraunschweiger/Development/platform/functions/.env.<projectId>`
2. Fill values.

Required keys:

- `GITHUB_TOKEN` (backend GitHub API token)
- `GITHUB_ORG_NAME` (default `gitcorps`)
- `BACKEND_BASE_URL` (for workflow callback input)
- `MIN_RUN_USD`, `MAX_RUN_USD`
- `GLOBAL_MAX_CONCURRENT_RUNS`
- `GLOBAL_MAX_DAILY_SPEND_USD`
- `PER_PROJECT_MAX_DAILY_SPEND_USD`
- `RUN_TOKEN_TTL_MINUTES`
- `RUN_QUEUE_CHECK_LIMIT`
- `BUCKET_RUNTIME_MINUTES_PER_USD`
- `BUCKET_TOKENS_PER_USD`

Runtime defaults:

- `AGENT_RUNTIME_DEFAULT=copilot_cli`
- `LLM_PROVIDER_DEFAULT=openai`
- `LLM_MODEL_DEFAULT=gpt-4.1`

## 5. Stripe Extension and Wallet Mapping

Install Firebase extension `firestore-stripe-payments` and enable one-time checkout.

Implemented mapping flow:

1. `createFundingCheckoutSession` writes checkout session with `metadata.projectId` and `payment_intent_data.metadata.projectId`.
2. Backend stores `checkoutSessionProjects/{sessionId}`.
3. `onCheckoutSessionUpdated` stores `paymentIntentProjects/{paymentIntentId}` when payment intent appears.
4. `onStripePaymentSucceeded` credits wallet idempotently and writes funding event.
5. Then backend calls `maybeStartRun(projectId)`.
6. If mapping races, entry is parked in `pendingStripePayments` and retried automatically.

## 6. GitHub Org, Token, and Copilot Setup

### 6.1 Backend Token (`GITHUB_TOKEN`)

Used by Functions for:

- create org repo
- write seed files (including workflow and runner)
- dispatch workflow runs

Required permissions (PAT or app installation equivalent):

- repository administration/create in org
- contents write
- actions/workflow write

### 6.2 Workflow Token (`GITCORPS_BOT_TOKEN`)

Set as org secret and use it for all workflow GitHub operations, including Copilot CLI authentication.

Required permissions:

- contents write
- pull requests write
- issues write
- actions read
- Copilot Requests

This one token is exported to `GH_TOKEN` and `GITHUB_TOKEN` for Copilot CLI.

### 6.4 Copilot Runtime Prereqs

- Copilot coding agent must be enabled in the org/repo.
- The bot user used for `GITCORPS_BOT_TOKEN` must have a Copilot seat/access.
- Seeded repos include `.github/agents/gitcorps.agent.md`.
- Workflow calls:
  - `copilot --prompt ... --allow-all --no-ask-user`
  - commit + push to `main`

## 7. BYOK Provider Configuration

Set org/repo variables:

- `LLM_PROVIDER_DEFAULT` (`openai` or `anthropic`)
- `LLM_MODEL_DEFAULT` (model id string)
- Optional `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`

Set secrets if needed by your Copilot BYOK setup:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Important implementation note:

- The runner passes provider/model preference into the Copilot task prompt.
- Actual Copilot model/provider selection is controlled by your GitHub Copilot/BYOK configuration in GitHub.

## 8. Frontend Environment

Create `/Users/jbraunschweiger/Development/platform/apps/web/.env.local`:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION=us-central1
```

## 9. Deploy and Local Run

Install:

```bash
npm install
```

Run web app:

```bash
npm run dev:web
```

Run functions emulator:

```bash
npm run dev:functions
```

Deploy:

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

## 10. GitHub Preflight Verification

Use callable `githubPreflight` (UI button or callable) before project creation.

Healthy result should include:

- `ok: true`
- `checks` includes `viewer_ok`, `org_ok`, `membership_ok`

Optional deep check:

- call with `{ "writeProbe": true }` to verify repo create + contents write + workflow write + cleanup.

## 11. End-to-End Verification Checklist

1. Create a project from `/new`.
2. Confirm repo was created and seeded with:
   - `VISION.md`
   - `STATUS.md`
   - `.github/workflows/gitcorps-agent.yml`
   - `.github/agents/gitcorps.agent.md`
   - `tools/gitcorps_runner.mjs`
3. Fund the project via Stripe.
4. Confirm wallet credit:
   - `projects/{projectId}.balanceCents` increased
   - `projects/{projectId}/fundingEvents/{paymentIntentId}` exists
5. Confirm run queued/started:
   - `projects/{projectId}.currentRunId` set
   - run doc exists under `projects/{projectId}/runs/{runId}`
6. In GitHub Actions run logs, verify:
   - `Notify backend runStarted` succeeded
   - `Install Copilot CLI` succeeded
   - `Validate Copilot CLI` succeeded
   - `Execute agent runner` succeeded
   - `Commit agent changes` executed (or no-op if no edits)
   - `Notify backend runFinished` succeeded
7. Confirm backend finalization:
   - run status moved to `succeeded` or `failed`
   - `project.currentRunId` cleared
   - `balanceCents` debited by charged amount
8. If balance still above `MIN_RUN_USD`, confirm next run auto-started.

## 12. Troubleshooting

### `Resource not accessible by personal access token`

Token is missing scope/permission (usually org repo create, contents write, or workflow write).

### `The default Firebase app does not exist`

Ensure Admin SDK initialization happens once in Functions runtime before Firestore access (already implemented in current code; redeploy if stale artifact deployed).

### Workflow cannot notify `runStarted`/`runFinished`

- Verify `BACKEND_BASE_URL` points to deployed functions base (`https://us-central1-<project>.cloudfunctions.net`).
- Verify payload is valid JSON (workflow now uses Node-generated JSON payloads).

### Run credits wallet but does not start

- Check orchestrator log entry `maybeStartRun evaluated after funding event`.
- Inspect `runResult.state` and `gateReason`.
- Verify concurrency/daily cap env values are not overly strict.

### Copilot run starts but no PR is merged

- Check workflow artifact `AGENT_SESSION_LOG.txt`.
- Confirm Copilot is enabled and `GITCORPS_BOT_TOKEN` has Copilot Requests permission.
- Confirm branch protection allows bot direct commits to `main` (or adjust policy for this MVP behavior).

### Copilot CLI auth failures

- Ensure `GITCORPS_BOT_TOKEN` is set as an org secret.
- Ensure token owner has Copilot seat/access.
- Ensure token includes fine-grained **Copilot Requests** permission.
