"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gitcorpsRunnerScript = gitcorpsRunnerScript;
function gitcorpsRunnerScript() {
    return `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

async function safeRead(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function listTree(rootDir, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const lines = [];

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    const relPath = path.relative('.', fullPath);
    lines.push(relPath + (entry.isDirectory() ? '/' : ''));

    if (entry.isDirectory()) {
      const childLines = await listTree(fullPath, depth + 1, maxDepth);
      for (const child of childLines) {
        lines.push(child);
      }
    }
  }

  return lines;
}

function truncate(input, maxLen = 2500) {
  if (!input) return '';
  if (input.length <= maxLen) return input;
  return input.slice(0, maxLen) + '\\n...[truncated]';
}

function extractJsonObject(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

class OpenAICompatibleProvider {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  }

  async complete(prompt) {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }

    const response = await fetch(this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are GitCorps autonomous coding agent planner.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error('OpenAI-compatible request failed: ' + response.status);
    }

    const json = await response.json();
    return json.choices?.[0]?.message?.content || '';
  }
}

class AnthropicCompatibleProvider {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
  }

  async complete(prompt) {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is missing');
    }

    const response = await fetch(this.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 900,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error('Anthropic-compatible request failed: ' + response.status);
    }

    const json = await response.json();
    const first = Array.isArray(json.content) ? json.content[0] : null;
    return typeof first?.text === 'string' ? first.text : '';
  }
}

class HeuristicRuntime {
  constructor() {
    this.id = 'heuristic';
  }

  async plan(context) {
    const firstVisionLine = (context.vision || '')
      .split(/\\r?\\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#'));

    return {
      attempted: firstVisionLine || 'Review repository and pick a baseline milestone.',
      changed: 'No code-generation runtime configured; STATUS.md updated with a concrete next milestone.',
      works: 'Runner executed planning and status update flow.',
      broken: 'No automated feature implementation happened in heuristic mode.',
      nextMilestone:
        firstVisionLine ||
        'Implement the first milestone from VISION.md with tests first where feasible.',
      summary:
        'Heuristic runtime executed. Read VISION.md and STATUS.md, inspected repository tree, and updated STATUS.md.',
    };
  }
}

class LlmRuntime {
  constructor(provider, runtimeId) {
    this.provider = provider;
    this.id = runtimeId;
  }

  async plan(context) {
    const prompt = [
      'You are an autonomous coding run planner for a public OSS project.',
      'Return strictly JSON with keys attempted, changed, works, broken, nextMilestone, summary.',
      'Rules:',
      '- Choose the next best milestone toward VISION.md.',
      '- Prefer test-first workflow when feasible.',
      '- Be concise and actionable.',
      '',
      'VISION.md:',
      context.vision || '[missing]',
      '',
      'STATUS.md:',
      context.status || '[missing]',
      '',
      'Repository tree sample:',
      context.tree.join('\\n'),
    ].join('\\n');

    const completion = await this.provider.complete(prompt);
    const json = extractJsonObject(completion);

    if (!json) {
      return new HeuristicRuntime().plan(context);
    }

    return {
      attempted: String(json.attempted || 'Planned next milestone from project context.'),
      changed: String(json.changed || 'Prepared milestone update.'),
      works: String(json.works || 'Planning completed.'),
      broken: String(json.broken || 'None reported.'),
      nextMilestone: String(json.nextMilestone || 'Continue incremental test-first implementation.'),
      summary: String(json.summary || 'Run planning completed.'),
    };
  }
}

function createRuntime() {
  const runtime = process.env.AGENT_RUNTIME || process.env.LLM_PROVIDER_DEFAULT || 'openai';
  const providerName = (process.env.LLM_PROVIDER_DEFAULT || runtime || 'openai').toLowerCase();
  const model = process.env.LLM_MODEL_DEFAULT || (providerName === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4.1');

  try {
    if (providerName === 'anthropic') {
      return new LlmRuntime(
        new AnthropicCompatibleProvider({
          apiKey: process.env.ANTHROPIC_API_KEY,
          baseUrl: process.env.ANTHROPIC_BASE_URL,
          model,
        }),
        'anthropic-compatible',
      );
    }

    return new LlmRuntime(
      new OpenAICompatibleProvider({
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL,
        model,
      }),
      'openai-compatible',
    );
  } catch {
    return new HeuristicRuntime();
  }
}

async function maybeRunTests(phase) {
  try {
    const pkgRaw = await fs.readFile('package.json', 'utf8');
    const pkg = JSON.parse(pkgRaw);
    if (!pkg.scripts || !pkg.scripts.test) {
      return { phase, executed: false, success: true, output: 'No test script found.' };
    }

    const output = execSync('npm test', {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 12 * 60_000,
    });

    return {
      phase,
      executed: true,
      success: true,
      output: truncate(output),
    };
  } catch (error) {
    const err = error;
    const out = err.stdout || err.stderr || err.message || String(error);
    return {
      phase,
      executed: true,
      success: false,
      output: truncate(String(out)),
    };
  }
}

async function sendHeartbeat(args, phase, message) {
  if (!args['backend-base-url'] || !args['run-token']) {
    return;
  }

  try {
    await fetch(args['backend-base-url'] + '/runHeartbeat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + args['run-token'],
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: args['project-id'],
        runId: args['run-id'],
        phase,
        message,
      }),
    });
  } catch {
    // Best effort heartbeat only.
  }
}

function composeStatusAppendix(runPlan, testBefore, testAfter, runtimeId) {
  const timestamp = new Date().toISOString();
  const worksLine = runPlan.works || 'N/A';
  const brokenLine = runPlan.broken || 'N/A';

  return [
    '',
    '## Run ' + timestamp,
    '',
    '### Runtime',
    '- Agent runtime: ' + runtimeId,
    '',
    '### Attempted',
    '- ' + runPlan.attempted,
    '',
    '### Changed',
    '- ' + runPlan.changed,
    '',
    '### Works',
    '- ' + worksLine,
    '',
    '### Broken',
    '- ' + brokenLine,
    '',
    '### Test-First Workflow Attempt',
    '- Pre-change tests: ' + (testBefore.executed ? (testBefore.success ? 'passed' : 'failed') : 'not run'),
    '- Post-change tests: ' + (testAfter.executed ? (testAfter.success ? 'passed' : 'failed') : 'not run'),
    '',
    '### Next Milestone',
    '- ' + runPlan.nextMilestone,
    '',
  ].join('\\n');
}

async function main() {
  const args = parseArgs(process.argv);

  const vision = await safeRead('VISION.md');
  const status = await safeRead('STATUS.md');
  const tree = await listTree('.');

  const runtime = createRuntime();

  await sendHeartbeat(args, 'planning', 'Loaded VISION.md, STATUS.md, and repository tree.');

  const runPlan = await runtime.plan({ vision, status, tree });

  await sendHeartbeat(args, 'testing', 'Running baseline tests before edits.');
  const testBefore = await maybeRunTests('before');

  await sendHeartbeat(args, 'status', 'Updating STATUS.md and writing run summary.');
  const testAfter = await maybeRunTests('after');

  const appendix = composeStatusAppendix(runPlan, testBefore, testAfter, runtime.id);
  const nextStatus = (status || '# STATUS\\n') + appendix;
  await fs.writeFile('STATUS.md', nextStatus, 'utf8');

  const summary = [
    '# Run Summary',
    '',
    '- Runtime: ' + runtime.id,
    '- Attempted: ' + runPlan.attempted,
    '- Changed: ' + runPlan.changed,
    '- Works: ' + runPlan.works,
    '- Broken: ' + runPlan.broken,
    '- Next milestone: ' + runPlan.nextMilestone,
    '- Pre-change tests: ' + (testBefore.executed ? (testBefore.success ? 'passed' : 'failed') : 'not run'),
    '- Post-change tests: ' + (testAfter.executed ? (testAfter.success ? 'passed' : 'failed') : 'not run'),
    '',
    '## Notes',
    runPlan.summary,
    '',
  ].join('\\n');

  await fs.writeFile('RUN_SUMMARY.md', summary, 'utf8');
  await sendHeartbeat(args, 'done', 'Runner completed successfully.');

  process.stdout.write(summary + '\\n');
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);

  const fallbackSummary = '# Run Summary\\n\\n- Runtime failure: ' + message + '\\n';
  await fs.writeFile('RUN_SUMMARY.md', fallbackSummary, 'utf8');
  process.stderr.write(message + '\\n');
  process.exitCode = 1;
});
`;
}
//# sourceMappingURL=runner.js.map