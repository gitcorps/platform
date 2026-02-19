export function gitcorpsWorkflowYaml(): string {
  return `name: GitCorps Agent Run

on:
  workflow_dispatch:
    inputs:
      projectId:
        description: Firestore project id
        required: true
        type: string
      runId:
        description: Firestore run id
        required: true
        type: string
      budgetCents:
        description: Budget for this run (cents)
        required: true
        type: string
      runToken:
        description: Short-lived run token
        required: true
        type: string
      backendBaseUrl:
        description: Backend base URL
        required: true
        type: string
      agentRuntime:
        description: Agent runtime adapter id
        required: true
        type: string

jobs:
  run-agent:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      PROJECT_ID: \${{ inputs.projectId }}
      RUN_ID: \${{ inputs.runId }}
      BUDGET_CENTS: \${{ inputs.budgetCents }}
      RUN_TOKEN: \${{ inputs.runToken }}
      BACKEND_BASE_URL: \${{ inputs.backendBaseUrl }}
      AGENT_RUNTIME: \${{ inputs.agentRuntime }}
      LLM_PROVIDER_DEFAULT: \${{ vars.LLM_PROVIDER_DEFAULT || 'openai' }}
      LLM_MODEL_DEFAULT: \${{ vars.LLM_MODEL_DEFAULT || 'gpt-4.1' }}
      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
      OPENAI_BASE_URL: \${{ vars.OPENAI_BASE_URL }}
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
      ANTHROPIC_BASE_URL: \${{ vars.ANTHROPIC_BASE_URL }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: main

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Notify backend runStarted
        run: |
          START_PAYLOAD=$(node -e 'process.stdout.write(JSON.stringify({projectId: process.env.PROJECT_ID, runId: process.env.RUN_ID}))')
          curl -fsSL -X POST "$BACKEND_BASE_URL/runStarted" \\
            -H "Authorization: Bearer $RUN_TOKEN" \\
            -H "Content-Type: application/json" \\
            -d "$START_PAYLOAD"

      - name: Execute agent runner
        run: |
          if [ ! -f tools/gitcorps_runner.mjs ]; then
            echo "Missing tools/gitcorps_runner.mjs" >&2
            exit 1
          fi
          node tools/gitcorps_runner.mjs \\
            --project-id "$PROJECT_ID" \\
            --run-id "$RUN_ID" \\
            --budget-cents "$BUDGET_CENTS" \\
            --backend-base-url "$BACKEND_BASE_URL" \\
            --run-token "$RUN_TOKEN" \\
            --agent-runtime "$AGENT_RUNTIME"

      - name: Commit agent changes
        run: |
          if git diff --quiet; then
            echo "No changes to commit"
            exit 0
          fi

          git config user.name "gitcorps-agent"
          git config user.email "agent@gitcorps.local"
          git add -A
          git commit -m "chore(agent): run $RUN_ID"
          git push origin main

      - name: Mark run status fallback
        if: always()
        run: echo "RUN_STATUS=failed" >> "$GITHUB_ENV"

      - name: Mark run status success
        if: success()
        run: echo "RUN_STATUS=succeeded" >> "$GITHUB_ENV"

      - name: Notify backend runFinished
        if: always()
        run: |
          FINISH_PAYLOAD=$(node -e 'const fs=require("fs");const p="RUN_SUMMARY.md";const txt=fs.existsSync(p)?fs.readFileSync(p,"utf8"):"Run finished without summary.";const spent=Number(process.env.BUDGET_CENTS||"0");process.stdout.write(JSON.stringify({projectId:process.env.PROJECT_ID,runId:process.env.RUN_ID,status:process.env.RUN_STATUS||"failed",spentCents:Number.isFinite(spent)?spent:0,summaryMd:txt}));')
          curl -fsSL -X POST "$BACKEND_BASE_URL/runFinished" \\
            -H "Authorization: Bearer $RUN_TOKEN" \\
            -H "Content-Type: application/json" \\
            -d "$FINISH_PAYLOAD"
`;
}
