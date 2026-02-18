# GitCorps – MVP Specification (v1)

## 0. Purpose

GitCorps is an experiment in “open source 2.0”: anyone can fund an autonomous coding agent to continuously build an open-source project toward a long-term vision. Projects run until their wallet runs out of money. The agent is the only committer. All output is MIT-licensed and fully public.

This MVP implements:
- Project creation with a manifesto (vision doc)
- Project wallets (crowdfunded)
- Autonomous agent runs on GitHub Actions
- Firebase backend for orchestration + payments
- BYOK LLM providers (OpenAI / Anthropic / compatible APIs)
- Direct commits to main (no PRs in v1)
- Test-driven development by the agent
- Minimal web UI (landing + project pages)

This is an experiment. Funds may be burned with no useful output. No guarantees. No ownership rights from funding.

Primary repo for this product:
- **GitHub:** `gitcorps/platform`

---

## 1. Core Product Behavior

### 1.1 Projects
- Anyone can create a project by writing a vision document and funding the project wallet.
- Each project corresponds to a public GitHub repo under the configured GitHub organization.
  - Default org: `gitcorps`
  - **Must be configurable** via backend environment/config.
- The agent is the only committer to the repo.
- All output is MIT-licensed by default.

### 1.2 Runs
- Projects run continuously until their wallet is empty.
- A project may only have one active run at a time.
- Runs auto-continue while balance remains (subject to global concurrency limits).
- If a run fails to start (GitHub Actions infra failure), it retries automatically.
- No refunds: if tokens/compute are spent, funds are consumed.

### 1.3 Agent Behavior (MVP Contract)
At the start of every run, the agent must:
- Read:
  - `VISION.md`
  - `STATUS.md`
  - entire repository state
- Decide the next best milestone toward the long-term vision.
- Perform test-driven development:
  - write tests first when feasible
  - implement features
  - run tests
  - ensure tests pass if possible
- Update documentation:
  - update `STATUS.md` with:
    - what was attempted
    - what changed
    - what works / what’s broken
    - what the next milestone should be
- Commit directly to `main` when work for the run is complete or budget/time is exhausted.

End-of-run required artifacts:
- Updated code
- Updated `STATUS.md`
- Tests added (where applicable)

The agent decides when a run is “done” based on progress and budget/time remaining.

---

## 2. Budget Semantics

### 2.1 Model
- Bucket model:
  - A fixed dollar amount maps to:
    - max runtime minutes
    - max token budget
- These conversion parameters are configurable constants in backend config.

### 2.2 Rules
- MIN_RUN_USD: minimum wallet balance required to start a run.
- MAX_RUN_USD: maximum spend per single run.
- GLOBAL_MAX_CONCURRENT_RUNS: system-wide concurrency cap.
- PER_PROJECT_MAX_CONCURRENT_RUNS = 1.
- Projects beyond global concurrency are queued FIFO.

### 2.3 Daily Spend Guardrails
- GLOBAL_MAX_DAILY_SPEND_USD (configurable)
- PER_PROJECT_MAX_DAILY_SPEND_USD (configurable)
- These are enforced by the backend orchestrator.

---

## 3. Tech Stack

### 3.1 Frontend
- Web app (Next.js recommended)
- Hosted on Firebase Hosting
- Pages:
  - Landing page with project list
  - Create project page
  - Project page (wallet, runs, links)

### 3.2 Backend
- Firebase:
  - Firebase Auth (human users)
  - Firestore (projects, runs, funding)
  - Cloud Functions (orchestration, GitHub integration)
- Stripe (Firebase Stripe extension for checkout + webhooks)

### 3.3 GitHub
- All project repos live under the configured GitHub org.
  - Default org: `gitcorps`
  - Must be configurable via backend config.
- Repos are public.
- GitHub App or org-level bot token for:
  - creating repos
  - dispatching workflows
  - pushing commits
- GitHub Actions as agent runtime substrate.

### 3.4 LLM Providers
- Bring Your Own Key (BYOK) provider keys owned by GitCorps for MVP.
- Initial support:
  - OpenAI-compatible APIs
  - Anthropic-compatible APIs
- Provider keys stored as GitHub org secrets and injected into Actions runs.

---

## 4. Configuration (No Hardcoding)

All of the following must be configurable (env/config), with defaults shown:

- GITHUB_ORG_NAME = `gitcorps`
- PUBLIC_SITE_DOMAIN = `gitcorps.com`
- PROJECT_SITE_TEMPLATE = `{slug}.gitcorps.com` (optional, not required to implement in MVP)
- DEFAULT_LICENSE = `MIT`
- MIN_RUN_USD
- MAX_RUN_USD
- GLOBAL_MAX_CONCURRENT_RUNS
- GLOBAL_MAX_DAILY_SPEND_USD
- PER_PROJECT_MAX_DAILY_SPEND_USD
- LLM_PROVIDER_DEFAULT (e.g., `openai` or `anthropic`)
- LLM_MODEL_DEFAULT (e.g., `gpt-4.1` / `claude-sonnet` etc.)

The frontend must render project links from stored project fields (`repoUrl`, `siteUrl`) rather than recomputing from defaults, so historical projects remain valid if config changes.

---

## 5. Firestore Data Model

### users/{uid}
- createdAt
- displayName
- stripeCustomerId (optional)

### projects/{projectId}
- slug
- name
- manifestoMd
- repoFullName
- repoUrl
- siteUrl (optional)
- createdByUid
- balanceCents
- currentRunId (nullable)
- status: active | paused | failed
- createdAt
- updatedAt

### projects/{projectId}/runs/{runId}
- status: queued | running | succeeded | failed | out_of_funds
- budgetCents
- spentCents (optional)
- startedAt
- endedAt
- heartbeatAt
- summaryMd
- agentRuntime

### projects/{projectId}/fundingEvents/{eventId}
- uid (nullable)
- amountCents
- stripePaymentIntentId
- createdAt

---

## 6. Cloud Functions (Required)

### 6.1 createProject (auth required)
Creates project metadata and repo:
- Creates Firestore project doc.
- Creates GitHub repo under configured org.
- Seeds the repo with:
  - `VISION.md` (manifesto)
  - `STATUS.md` (initial template)
  - `.github/workflows/gitcorps-agent.yml`
  - `LICENSE` (MIT)

Returns:
- projectId
- repoUrl
- repoFullName

### 6.2 onStripePaymentSucceeded (webhook via Stripe extension)
- Validates idempotency
- Credits project wallet balance
- Creates fundingEvent
- Calls maybeStartRun(projectId)

### 6.3 maybeStartRun(projectId)
Orchestrator logic:
- If project.currentRunId != null → return
- If project.balanceCents < MIN_RUN_CENTS → return
- If global concurrency >= GLOBAL_MAX_CONCURRENT_RUNS → enqueue project and return
- If daily spend caps would be exceeded → return / enqueue
- Else:
  - budgetCents = min(balanceCents, MAX_RUN_CENTS)
  - create run doc with status = queued
  - set project.currentRunId = runId and status = active
  - generate short-lived runToken scoped to that run
  - dispatch GitHub Actions workflow with inputs:
    - projectId, runId, budgetCents, runToken, backendBaseUrl, agentRuntime

### 6.4 runStarted (agent-auth)
- Validates runToken
- Marks run running
- Sets startedAt, heartbeatAt

### 6.5 runHeartbeat (agent-auth)
- Validates runToken
- Updates heartbeatAt and optional message/phase

### 6.6 runFinished (agent-auth)
- Validates runToken
- Updates run status + endedAt + summaryMd
- Clears project.currentRunId
- Deducts budget from balance (bucket model)
- If balance remains and project not queued behind others, auto-continue via maybeStartRun

---

## 7. GitHub Actions Workflow Contract

Workflow file: `.github/workflows/gitcorps-agent.yml`

Trigger: workflow_dispatch

Inputs:
- projectId
- runId
- budgetCents
- runToken
- backendBaseUrl
- agentRuntime

Required behavior:
- checkout repo
- install agent runner dependencies
- call backend runStarted
- execute agent loop
- commit changes directly to main
- call backend runFinished

---

## 8. Agent Runner Abstraction (Implementation Requirement)

The workflow must run a repo-local runner entrypoint (so it can evolve), e.g.:
- `./tools/gitcorps_runner` (Node/TS) or `./tools/gitcorps_runner.py`

Runner responsibilities:
- Load vision and state:
  - read `VISION.md`, `STATUS.md`
  - inspect repo tree
- Choose next milestone and implement it
- Prefer test-driven flow
- Update `STATUS.md`
- Produce a concise run summary returned to backend

The runner must be runtime-agnostic:
- initial implementation may use a specific agent runtime (Copilot SDK BYOK or another)
- architecture must allow swapping provider/runtime later

---

## 9. License & Legal

- Default license: MIT.
- Funding confers no ownership rights.
- Funds may be burned without useful output.
- No warranties, no guarantees.
- Prominent disclaimer in UI at:
  - create project
  - fund project

---

## 10. Minimal UI Requirements

### Landing page `/`
- Product description
- CTA: Create Project
- List recent projects (from Firestore)
- Each project card includes:
  - name
  - short excerpt of manifesto
  - balance
  - status
  - link to project page

### Create project `/new`
- Form fields:
  - name
  - slug (auto-suggest; must be unique)
  - manifesto (markdown)
  - initial funding amount
- Stripe checkout
- On success: project page

### Project page `/p/{slug}`
- Name, manifesto
- Balance + status
- Fund button
- Link to GitHub repo
- Run history list (latest 10–20)
- Latest run summary and timestamps
- Disclaimer visible on funding UI

---

## 11. Deliverables Required in `gitcorps/platform`

The implementation must include:
- Full codebase (frontend + backend)
- `SETUP.md` with step-by-step:
  - Firebase project creation
  - Auth setup
  - Firestore rules/indices
  - Stripe extension setup + webhook handling
  - GitHub org/app/token setup
  - Secrets configuration (GitHub + Firebase)
  - Deployment steps
  - Local dev instructions
- Automated tests where practical (backend logic + any pure functions)
