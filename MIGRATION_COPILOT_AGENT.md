# GitCorps Migration Plan: Replace In-Run LLM Calls with Copilot Agent Sessions

## 1. Why migrate

Current run execution uses a custom runner (`tools/gitcorps_runner.mjs`) that performs a provider call and status update loop. This diverges from the desired paradigm: each run should execute a true agentic loop managed by GitHub Copilot agent runtime, while GitCorps retains funding/run orchestration.

## 2. Feasibility summary

### 2.1 What is feasible now

- Keep GitCorps backend orchestration (`maybeStartRun`, budget gates, queueing, run tokens, wallet accounting).
- Replace the "inside-run" execution substrate with Copilot agent session creation and monitoring.
- Keep continuous execution semantics: when a run settles and budget remains, trigger another Copilot session.

### 2.2 Hard constraints from Copilot agent model

- Copilot coding agent is PR/session-oriented, not direct commit-to-main.
- Copilot pushes to draft PR branches and requires review/approval semantics in normal flow.
- Copilot can be started from multiple entry points (issues, agents panel, CLI, MCP host tools), but session lifecycle is external to your current custom runner loop.

Implication: maintain custom high-level orchestrator, but treat "run execution" as "create Copilot task -> watch session/PR -> merge policy -> close run".

## 3. Target architecture

### 3.1 Control-plane ownership (GitCorps)

GitCorps continues to own:

- Funding and balance ledger
- Run eligibility (`MIN_RUN_USD`, daily caps, global concurrency)
- Queueing/retry/recovery
- Run state machine in Firestore
- Cost guardrails and auto-continue behavior

### 3.2 Execution-plane ownership (Copilot)

Copilot agent owns:

- Repo analysis and iterative planning
- Multi-step edit/test loop in its own environment
- Producing code changes as PR commits

### 3.3 New run lifecycle

1. `maybeStartRun(projectId)` creates run doc (`queued`) and sets `currentRunId`.
2. Backend starts Copilot agent session for repo + task prompt (derived from `VISION.md`, `STATUS.md`, budget metadata).
3. Backend records `executionRef` (session id / task id / PR number) on run.
4. Poller/webhook updates run phase (`running`) and heartbeat.
5. When Copilot marks task complete and PR is ready:
   - Apply merge policy (automatic or gated).
   - Extract summary from session/PR metadata.
6. Call `runFinished` semantics in backend:
   - mark ended
   - charge run
   - clear `currentRunId`
   - auto-continue if balance remains.

## 4. Integration options

## Option A (Recommended): GitHub-native agent task flow

Use GitHub’s Copilot coding agent task mechanism as the execution substrate (issue/task -> draft PR session), and monitor session state + PR status.

Pros:

- True agentic loop on GitHub-managed runtime
- Less custom model API handling and fewer provider-shape bugs
- Better future compatibility with Copilot agent improvements

Cons:

- PR-centric semantics require merge policy changes
- Requires copilot entitlements/policies and operational configuration

## Option B: Copilot CLI/ACP in Actions runner

Run Copilot CLI in workflow jobs and let it operate iteratively in repository checkout.

Pros:

- Keeps closer shape to current workflow
- Easier incremental migration from custom runner

Cons:

- CLI currently preview and operationally less stable
- Still requires command-level orchestration and robust output parsing
- Not equivalent to full asynchronous coding-agent session model

Recommendation: Option A for production architecture; Option B only as temporary bridge.

## 5. Data model changes

Add run execution fields to `projects/{projectId}/runs/{runId}`:

- `executionProvider`: `copilot_coding_agent`
- `executionMode`: `task_pr`
- `executionRef`: opaque id (session/task id)
- `executionPrNumber`: number | null
- `executionBranch`: string | null
- `executionUrl`: string | null
- `executionStatus`: `submitted | in_progress | completed | failed | canceled`
- `executionLastHeartbeatAt`: timestamp
- `mergeStatus`: `not_applicable | pending | merged | blocked | failed`
- `mergeCommitSha`: string | null
- `failureCode`: string | null
- `failureDetail`: string | null

## 6. Orchestrator changes

### 6.1 Replace workflow dispatch step

Current `dispatchWorkflow(...)` becomes `startRunExecution(...)` with provider adapter.

Interface:

- `startRunExecution({ repoFullName, runId, projectId, budgetCents, prompt }) -> executionRef`
- `getExecutionStatus(executionRef) -> { status, heartbeatAt, prNumber?, summary? }`
- `finalizeExecution(executionRef) -> { merged, sha?, summary }`

### 6.2 New scheduler loops

- `pollExecutionStatus` every 1-2 min:
  - update run heartbeat and phase
  - detect completion/failure/timeouts
- `reconcileExecutionMerges` every 2-5 min:
  - perform/verify merge policy
  - transition run to finished

### 6.3 Merge policy abstraction

Configurable per environment/project:

- `RUN_MERGE_POLICY=auto_merge_if_checks_pass`
- `RUN_MERGE_POLICY=maintainer_approval_required`
- `RUN_MERGE_POLICY=never_auto_merge`

For your requested behavior (continuous while budget remains), use `auto_merge_if_checks_pass` for MVP.

## 7. Prompting contract for Copilot sessions

Each task prompt should include:

- Budget context (`budgetCents`, expected max scope)
- Required files to read first (`VISION.md`, `STATUS.md`)
- Required outcomes:
  - test-first where feasible
  - update `STATUS.md` with required sections
  - concise run summary in `RUN_SUMMARY.md`

Maintain repository instruction files to keep behavior deterministic.

## 8. Security and access prerequisites

- Copilot coding agent enabled by org/repo policy
- Repository allows agent operation with required branch/PR settings
- GitHub token/app permissions for:
  - creating/updating task trigger artifacts (issue/task if used)
  - polling session/PR state
  - merging PR (if auto-merge policy)

## 9. Budget semantics mapping

Copilot session cost and runtime are not token-metered the same as direct model API calls. Keep current bucket accounting as control-plane abstraction:

- `budgetCents` still computed by backend
- run timeout and stale detection still enforced by backend
- charge on run completion (capped by run budget)

If desired, add empirical estimator to tune bucket constants based on observed session durations.

## 10. Migration phases

## Phase 0: Stabilize current path (done)

- Keep current custom runner operational with fallback.

## Phase 1: Execution adapter abstraction (1-2 days)

- Introduce `RunExecutionAdapter` interface.
- Keep current workflow as `LegacyWorkflowAdapter`.
- Add feature flag: `RUN_EXECUTION_MODE=legacy|copilot`.

## Phase 2: Copilot adapter MVP (3-5 days)

- Implement `CopilotTaskAdapter` for session creation + polling + completion.
- Persist execution refs in run docs.
- Implement merge policy executor.

## Phase 3: Flip default (1 day)

- Set `RUN_EXECUTION_MODE=copilot` in prod.
- Keep legacy adapter as rollback path.

## Phase 4: Remove duplicated custom runner logic (1 day)

- Stop seeding heavy custom LLM loop into repos.
- Keep minimal repo-side artifacts only for status/report conventions.

## 11. Risks and mitigations

- Risk: Copilot API/entrypoint variability.
  - Mitigation: adapter boundary + capability probing + fallback to legacy adapter.
- Risk: PR merge blockers stall run throughput.
  - Mitigation: explicit merge policy and blocked-run timeout/escalation.
- Risk: Session observability gaps.
  - Mitigation: persist `executionRef`, URLs, status snapshots, structured error codes.

## 12. Concrete implementation backlog

1. Add `RunExecutionAdapter` and config flag.
2. Refactor `maybeStartRun` to call adapter instead of direct workflow dispatch.
3. Add Firestore fields for execution tracking.
4. Build Copilot adapter (start/poll/finalize).
5. Add scheduler jobs for poll + merge reconcile.
6. Add UI run details for execution URL, PR link, merge state.
7. Update `SETUP.md` with Copilot policy and permissions.
8. Add integration tests around state transitions (`queued -> running -> succeeded/failed`).

## 13. Recommendation

Proceed with Option A and keep GitCorps orchestration unchanged. Treat Copilot as run execution engine, not as billing/orchestration owner. This gives the "best of both worlds":

- GitCorps controls money, queueing, and continuity.
- Copilot handles true iterative coding agent loops.
- Merge-to-main can be automated or policy-gated while preserving run continuity.
