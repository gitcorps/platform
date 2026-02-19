#!/usr/bin/env node
import { promises as fs, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DEFAULT_RUNTIME = 'copilot_cli';
const TASK_FILE = '.gitcorps-task.md';
const LOG_FILE = 'AGENT_SESSION_LOG.txt';
const SUMMARY_FILE = 'RUN_SUMMARY.md';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

function asString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function clip(value, maxLen = 4000) {
  const text = asString(value);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n...[truncated]';
}

async function safeReadFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function hasValidAgentFrontmatter(raw, expectedName) {
  const text = asString(raw);
  if (!text.startsWith('---\n')) {
    return false;
  }
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) {
    return false;
  }
  const header = text.slice(4, end);
  const escapedName = expectedName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const nameRegex = new RegExp('^name\\s*:\\s*' + escapedName + '\\s*$', 'mi');
  return nameRegex.test(header);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runCommand(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
    cwd: process.cwd(),
  });

  const stdout = asString(result.stdout);
  const stderr = asString(result.stderr);
  const code = typeof result.status === 'number' ? result.status : (result.error ? 1 : 0);
  const ok = code === 0 && !result.error;

  if (!ok && !options.allowFailure) {
    const errText = result.error ? asString(result.error.message || result.error) : '';
    throw new Error(
      cmd +
        ' ' +
        args.join(' ') +
        ' failed (code=' +
        code +
        ')\nstdout:\n' +
        clip(stdout, 2000) +
        '\nstderr:\n' +
        clip(stderr || errText, 2000),
    );
  }

  return {
    ok,
    code,
    stdout,
    stderr,
    error: result.error ? asString(result.error.message || result.error) : '',
  };
}

async function sendHeartbeat(args, phase, message) {
  const baseUrl = asString(args['backend-base-url']).replace(/\/+$/, '');
  const token = asString(args['run-token']);
  const projectId = asString(args['project-id']);
  const runId = asString(args['run-id']);

  if (!baseUrl || !token || !projectId || !runId) {
    return;
  }

  await fetch(baseUrl + '/runHeartbeat', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      projectId,
      runId,
      phase,
      message,
    }),
  }).catch(() => {
    // best-effort heartbeat only
  });
}

function hasTestScript() {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    return Boolean(pkg && pkg.scripts && typeof pkg.scripts.test === 'string' && pkg.scripts.test.length > 0);
  } catch {
    return false;
  }
}

function runTests(phase) {
  if (!hasTestScript()) {
    return {
      phase,
      executed: false,
      success: true,
      output: 'No test script detected.',
    };
  }

  const result = runCommand('npm', ['test'], { allowFailure: true });
  return {
    phase,
    executed: true,
    success: result.ok,
    output: clip((result.stdout + '\n' + result.stderr).trim(), 2500),
  };
}

function changedFileCount() {
  const status = runCommand('git', ['status', '--porcelain'], { allowFailure: true });
  if (!status.ok) {
    return 0;
  }
  const lines = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length;
}

function buildPrompt(input) {
  return [
    '# GitCorps Run Request',
    '',
    '- Project ID: ' + input.projectId,
    '- Run ID: ' + input.runId,
    '- Budget (USD cents): ' + input.budgetCents,
    '- Runtime: ' + input.runtimeId,
    '- Provider preference (BYOK): ' + input.provider + ' / ' + input.model,
    '',
    '## Required Workflow',
    '',
    '1. Read VISION.md and STATUS.md before making changes.',
    '2. Inspect the repository state and pick the next highest-leverage milestone.',
    '3. Use test-first development when feasible.',
    '4. Implement focused changes for the milestone.',
    '5. Run tests where available and fix in-scope failures.',
    '6. Update STATUS.md with attempted work, changes, working state, broken state, and next milestone.',
    '7. Keep edits incremental and avoid unnecessary rewrites.',
    '',
    '## Constraints',
    '',
    '- Respect existing project structure and style.',
    '- If blocked, document blocker details and concrete next step in STATUS.md.',
    '- Prefer small, verifiable improvements that can be committed directly to main.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const runtimeId = asString(args['agent-runtime'] || process.env.AGENT_RUNTIME || DEFAULT_RUNTIME);
  if (runtimeId !== DEFAULT_RUNTIME) {
    throw new Error("Unsupported AGENT_RUNTIME '" + runtimeId + "'. Supported: '" + DEFAULT_RUNTIME + "'.");
  }

  const token = asString(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
  if (!token) {
    throw new Error('Missing GH_TOKEN/GITHUB_TOKEN for Copilot CLI authentication.');
  }
  process.env.GH_TOKEN = token;
  process.env.GITHUB_TOKEN = token;

  await sendHeartbeat(args, 'bootstrap', 'Validating Copilot CLI runtime.');
  const version = runCommand('copilot', ['--version'], { allowFailure: true });
  if (!version.ok) {
    throw new Error('Copilot CLI is not available in PATH. Install @github/copilot before runner execution.');
  }

  const projectId = asString(args['project-id']);
  const runId = asString(args['run-id']);
  const budgetCents = asString(args['budget-cents'] || '0');
  const provider = asString(process.env.LLM_PROVIDER_DEFAULT || 'openai');
  const model = asString(process.env.LLM_MODEL_DEFAULT || 'gpt-4.1');
  const agentName = asString(process.env.GITCORPS_COPILOT_AGENT_NAME || 'gitcorps');

  const vision = await safeReadFile('VISION.md');
  const statusBefore = await safeReadFile('STATUS.md');
  if (!vision.trim()) {
    throw new Error('VISION.md is missing or empty.');
  }
  if (!statusBefore.trim()) {
    throw new Error('STATUS.md is missing or empty.');
  }

  await sendHeartbeat(args, 'testing_before', 'Running baseline tests before Copilot execution.');
  const testBefore = runTests('before');

  const prompt = buildPrompt({
    projectId,
    runId,
    budgetCents,
    runtimeId,
    provider,
    model,
  });
  await fs.writeFile(TASK_FILE, prompt, 'utf8');

  const cliArgs = ['--prompt', prompt, '--allow-all', '--no-ask-user'];
  if (model) {
    cliArgs.push('--model', model);
  }
  let resolvedAgentProfile = '';
  if (agentName) {
    const canonical = '.github/agents/' + agentName + '.agent.md';
    const legacy = '.github/agents/' + agentName + '.md';
    if (await fileExists(canonical)) {
      const content = await safeReadFile(canonical);
      if (hasValidAgentFrontmatter(content, agentName)) {
        resolvedAgentProfile = canonical;
      }
    } else if (await fileExists(legacy)) {
      const content = await safeReadFile(legacy);
      if (hasValidAgentFrontmatter(content, agentName)) {
        resolvedAgentProfile = legacy;
      }
    }
  }
  if (resolvedAgentProfile) {
    cliArgs.push('--agent', agentName);
  }

  await sendHeartbeat(args, 'copilot_execute', 'Running Copilot CLI prompt.');
  const runResult = runCommand('copilot', cliArgs, { allowFailure: true });
  const runOutput = (runResult.stdout + '\n' + runResult.stderr).trim();
  await fs.writeFile(LOG_FILE, runOutput + '\n', 'utf8');
  if (!runResult.ok) {
    throw new Error('Copilot CLI execution failed.\n' + clip(runOutput, 3000));
  }

  await sendHeartbeat(args, 'testing_after', 'Running tests after Copilot execution.');
  const testAfter = runTests('after');
  const statusAfter = await safeReadFile('STATUS.md');
  const changedCount = changedFileCount();

  const summary = [
    '# Run Summary',
    '',
    '- Runtime: copilot-cli',
    '- Attempted: Copilot CLI non-interactive run in GitHub Actions',
    '- Changed: ' + (changedCount > 0 ? 'repository has ' + changedCount + ' changed file(s) pending commit' : 'no file changes detected'),
    '- Works: Copilot CLI executed with BYOK preference ' + provider + '/' + model,
    '- Broken: none reported by runner infrastructure',
    '- Next milestone: continue from latest STATUS.md milestone',
    '- Pre-change tests: ' + (testBefore.executed ? (testBefore.success ? 'passed' : 'failed') : 'not run'),
    '- Post-change tests: ' + (testAfter.executed ? (testAfter.success ? 'passed' : 'failed') : 'not run'),
    '',
    '## Notes',
    'Runner prompt required reading VISION.md and STATUS.md with a test-first workflow.',
    'STATUS.md updated: ' + (statusAfter !== statusBefore ? 'yes' : 'no'),
    'Agent profile: ' + (resolvedAgentProfile || 'default'),
    '',
    '## Copilot Output (tail)',
    '~~~text',
    clip(runOutput, 2500),
    '~~~',
    '',
  ].join('\n');

  await fs.writeFile(SUMMARY_FILE, summary, 'utf8');
  await sendHeartbeat(args, 'done', 'Copilot CLI run completed.');
  process.stdout.write(summary + '\n');
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  const summary = [
    '# Run Summary',
    '',
    '- Runtime: copilot-cli',
    '- Attempted: Copilot CLI run orchestration',
    '- Changed: none (runner failed before commit)',
    '- Works: backend callbacks and diagnostics still executed',
    '- Broken: ' + clip(message, 3000),
    '- Next milestone: resolve runtime/auth/tooling error and rerun',
    '',
    '## Notes',
    'See AGENT_SESSION_LOG.txt for captured Copilot CLI output when available.',
    '',
  ].join('\n');

  await fs.writeFile(SUMMARY_FILE, summary, 'utf8').catch(() => {});
  const args = parseArgs(process.argv);
  await sendHeartbeat(args, 'failed', clip(message, 500)).catch(() => {});
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
