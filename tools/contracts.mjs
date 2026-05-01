// Deterministic contract checkers (Phase 9.1).
//
// Each checker takes a contract spec and a context and returns a result:
//   { id, type, passed, evidence, error?, contentHash? }
//
// `evidence` is a short human-readable string for the UI; `contentHash` is
// a SHA256 of the input artifact (file content, command output, or diff)
// used by the validator to keep results idempotent on (run, contract,
// content) — see Phase 9.2.
//
// Contracts are intentionally implemented in code first. The PRD's YAML
// loader is deferred until 3+ checkers are working, per the original plan.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { runSandboxed } from './contract-sandbox.mjs';

// --- public API --------------------------------------------------------

// Run a list of contracts and collect their results. Failures of one
// contract never throw — they're reported as { passed: false, error: ... }.
export async function evaluateContracts(specs, context) {
  const results = [];
  for (const spec of specs) {
    const result = await evaluateContract(spec, context);
    results.push(result);
  }
  return results;
}

export async function evaluateContract(spec, context) {
  if (!spec || typeof spec !== 'object') {
    return failResult(spec, 'invalid_spec', 'spec must be an object');
  }
  const id = spec.id ?? `contract-${spec.type}`;
  const checker = CHECKERS[spec.type];
  if (!checker) {
    return {
      id,
      type: spec.type ?? 'unknown',
      passed: false,
      evidence: `unknown contract type: ${spec.type}`,
      error: 'unknown_type',
    };
  }
  try {
    const out = await checker(spec, context || {});
    return {
      id,
      type: spec.type,
      passed: out.passed,
      evidence: out.evidence,
      contentHash: out.contentHash,
      ...(out.error ? { error: out.error } : {}),
    };
  } catch (err) {
    return failResult(spec, 'checker_error', String(err.message || err));
  }
}

// --- checkers ----------------------------------------------------------

const CHECKERS = {
  file_exists: checkFileExists,
  command_exit: checkCommandExit,
  content_structure: checkContentStructure,
  file_modified: checkFileModified,
  min_links: checkMinLinks,
  git_diff_in_paths: checkGitDiffInPaths,
  // Phase 9.3 — LLM-as-judge band. Lives in a separate `band: 'judge'`
  // family so a judge result alone never clears `unverified`.
  judge: checkJudge,
};

// Each contract type lands in one of two bands. `band: 'deterministic'`
// covers the reproducible checkers; `band: 'judge'` is the LLM-as-judge
// family added in Phase 9.3. The rollup keeps them separate so judge
// results can't dress up unverified output as `verified`.
const CONTRACT_BANDS = {
  file_exists: 'deterministic',
  command_exit: 'deterministic',
  content_structure: 'deterministic',
  file_modified: 'deterministic',
  min_links: 'deterministic',
  git_diff_in_paths: 'deterministic',
  judge: 'judge',
};

export function bandFor(type) {
  return CONTRACT_BANDS[type] || 'deterministic';
}

async function checkFileExists(spec, ctx) {
  const paths = arr(spec.paths);
  if (paths.length === 0) {
    return { passed: false, evidence: 'no paths specified' };
  }
  const cwd = resolveCwd(spec, ctx);
  const missing = [];
  const present = [];
  for (const p of paths) {
    const full = resolve(cwd, p);
    if (existsSync(full)) present.push(p);
    else missing.push(p);
  }
  const passed = missing.length === 0;
  return {
    passed,
    evidence: passed
      ? `all ${present.length} present`
      : `missing: ${missing.join(', ')}`,
    contentHash: hashOf(present.sort().join('\n')),
  };
}

async function checkCommandExit(spec, ctx) {
  if (!spec.command) {
    return { passed: false, evidence: 'no command specified' };
  }
  const cwd = resolveCwd(spec, ctx);
  const expected = spec.expectedExitCode ?? 0;
  const result = await runSandboxed(
    {
      command: spec.command,
      args: spec.args || [],
      cwd,
      timeoutMs: spec.timeoutMs,
      env: spec.env,
      envAllow: spec.envAllow,
      inheritPath: spec.inheritPath ?? true,
    },
    { allowedBasePaths: ctx.allowedBasePaths || [process.cwd()] }
  );
  const passed =
    result.terminationReason === 'exit' && result.exitCode === expected;
  const head =
    result.stdout.length > 200
      ? result.stdout.slice(0, 200) + '…'
      : result.stdout;
  return {
    passed,
    evidence: passed
      ? `exit ${result.exitCode} in ${result.durationMs}ms`
      : `${result.terminationReason} (exit=${result.exitCode}, expected=${expected})${result.stderr ? ' · ' + result.stderr.slice(0, 120) : ''}`,
    contentHash: hashOf(
      `${result.exitCode}|${result.terminationReason}|${head}`
    ),
  };
}

async function checkContentStructure(spec, ctx) {
  const cwd = resolveCwd(spec, ctx);
  const full = resolve(cwd, spec.path || '');
  if (!existsSync(full)) {
    return { passed: false, evidence: `file not found: ${spec.path}` };
  }
  const content = readFileSync(full, 'utf8');
  const lines = content.split('\n');
  const failures = [];
  if (typeof spec.minLines === 'number' && lines.length < spec.minLines) {
    failures.push(`only ${lines.length} lines (need ${spec.minLines})`);
  }
  if (Array.isArray(spec.requireHeadings)) {
    const headings = lines
      .filter((l) => /^#{1,6}\s+/.test(l))
      .map((l) => l.replace(/^#{1,6}\s+/, '').trim());
    const missing = spec.requireHeadings.filter(
      (h) => !headings.some((found) => found.toLowerCase() === h.toLowerCase())
    );
    if (missing.length > 0) {
      failures.push(`missing headings: ${missing.join(', ')}`);
    }
  }
  if (Array.isArray(spec.requireRegex)) {
    for (const pat of spec.requireRegex) {
      try {
        const re = new RegExp(pat);
        if (!re.test(content)) failures.push(`regex no match: ${pat}`);
      } catch (err) {
        failures.push(`bad regex ${pat}: ${err.message}`);
      }
    }
  }
  const passed = failures.length === 0;
  return {
    passed,
    evidence: passed
      ? `${lines.length} lines, all checks passed`
      : failures.join('; '),
    contentHash: hashOf(content),
  };
}

async function checkFileModified(spec, ctx) {
  const cwd = resolveCwd(spec, ctx);
  const full = resolve(cwd, spec.path || '');
  if (!existsSync(full)) {
    return { passed: false, evidence: `file not found: ${spec.path}` };
  }
  const since = spec.sinceIso || ctx.runStartedAt;
  if (!since) {
    return {
      passed: false,
      evidence: 'no `sinceIso` and no runStartedAt in context',
    };
  }
  const sinceMs = new Date(since).getTime();
  if (Number.isNaN(sinceMs)) {
    return { passed: false, evidence: `bad sinceIso: ${since}` };
  }
  const mtime = statSync(full).mtimeMs;
  const passed = mtime > sinceMs;
  return {
    passed,
    evidence: passed
      ? `mtime ${new Date(mtime).toISOString()} > ${new Date(sinceMs).toISOString()}`
      : `mtime ${new Date(mtime).toISOString()} not after ${new Date(sinceMs).toISOString()}`,
    contentHash: hashOf(`${full}|${mtime}`),
  };
}

async function checkMinLinks(spec, ctx) {
  const cwd = resolveCwd(spec, ctx);
  const full = resolve(cwd, spec.path || '');
  if (!existsSync(full)) {
    return { passed: false, evidence: `file not found: ${spec.path}` };
  }
  const required = spec.count ?? 1;
  const content = readFileSync(full, 'utf8');
  // Markdown links: [text](url). Skip image links (preceded by !).
  const re = /(^|[^!])\[[^\]]+\]\([^\s)]+\)/g;
  const matches = content.match(re) || [];
  const passed = matches.length >= required;
  return {
    passed,
    evidence: `${matches.length} links found (need ≥${required})`,
    contentHash: hashOf(content),
  };
}

// Judge checker (Phase 9.3). Runs an LLM evaluation against an artifact.
//
// spec:
//   id, type: 'judge'
//   criterion: string (what the judge should evaluate against)
//   path?: string (file to read as artifact body)
//   text?: string (inline artifact body, used if path absent)
//   maxArtifactBytes?: number (defaults to 64KB; oversize is truncated)
//
// ctx.judgeRunner: optional async (prompt) => { verdict, reasoning } —
// injected for tests. In production it's wired up in console-server to
// `claude --print` (see runJudgeViaClaude below for the default).
async function checkJudge(spec, ctx) {
  if (!spec.criterion) {
    return { passed: false, evidence: 'no criterion specified' };
  }
  let artifact;
  if (spec.path) {
    const cwd = resolveCwd(spec, ctx);
    const full = resolve(cwd, spec.path);
    if (!existsSync(full)) {
      return { passed: false, evidence: `file not found: ${spec.path}` };
    }
    artifact = readFileSync(full, 'utf8');
  } else if (typeof spec.text === 'string') {
    artifact = spec.text;
  } else {
    return { passed: false, evidence: 'no path or text supplied' };
  }

  const cap = spec.maxArtifactBytes ?? 64 * 1024;
  if (artifact.length > cap) {
    artifact = artifact.slice(0, cap) + '\n\n[truncated]';
  }

  const runner = ctx.judgeRunner || runJudgeViaClaude;
  const prompt = buildJudgePrompt(spec.criterion, artifact);

  let outcome;
  try {
    outcome = await runner(prompt, spec, ctx);
  } catch (err) {
    return {
      passed: false,
      evidence: `judge runtime error: ${err.message || err}`,
      contentHash: hashOf(artifact),
    };
  }

  const verdict =
    outcome?.verdict === 'ok' || outcome?.verdict === 'concerns'
      ? outcome.verdict
      : 'concerns';
  const reasoning = outcome?.reasoning || '(no reasoning provided)';

  return {
    passed: verdict === 'ok',
    evidence: `${verdict}: ${reasoning.slice(0, 200)}`,
    contentHash: hashOf(`${spec.criterion}|${artifact}`),
    verdict, // exposed for the rollup so it can pick judged_ok vs judged_concerns
  };
}

function buildJudgePrompt(criterion, artifact) {
  return [
    'You are an evaluator. Judge whether the artifact below meets the criterion.',
    'Reply with ONLY a single-line JSON object — no prose, no markdown — of the form:',
    '{"verdict":"ok","reasoning":"…"}  OR  {"verdict":"concerns","reasoning":"…"}',
    '',
    `Criterion: ${criterion}`,
    '',
    'Artifact:',
    artifact,
  ].join('\n');
}

// Default judge runtime — shells out to `claude --print` and parses the
// last JSON object from its stdout. Tests inject a stub via
// ctx.judgeRunner; this path runs in production via console-server.
async function runJudgeViaClaude(prompt) {
  const result = await runSandboxed(
    {
      command: 'claude',
      args: ['--print'],
      cwd: process.cwd(),
      timeoutMs: 60_000,
      inheritPath: true,
      envAllow: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_SSE_PORT'],
      stdin: prompt,
    },
    { allowedBasePaths: [process.cwd()] }
  );
  if (result.terminationReason !== 'exit' || result.exitCode !== 0) {
    throw new Error(
      `claude exited ${result.exitCode} (${result.terminationReason})`
    );
  }
  // Take the last `{...}` block in stdout — claude sometimes adds prose.
  const matches = result.stdout.match(/\{[^{}]*"verdict"[^{}]*\}/g);
  if (!matches || matches.length === 0) {
    throw new Error(`no JSON verdict found in: ${result.stdout.slice(0, 200)}`);
  }
  return JSON.parse(matches[matches.length - 1]);
}

async function checkGitDiffInPaths(spec, ctx) {
  const allowed = arr(spec.allowedPaths);
  const baseRef = spec.baseRef || 'HEAD~1';
  const cwd = resolveCwd(spec, ctx);
  const result = await runSandboxed(
    {
      command: 'git',
      args: ['diff', '--name-only', baseRef],
      cwd,
      timeoutMs: spec.timeoutMs ?? 10000,
      inheritPath: true,
    },
    { allowedBasePaths: ctx.allowedBasePaths || [process.cwd()] }
  );
  if (result.exitCode !== 0) {
    return {
      passed: false,
      evidence: `git diff failed: ${result.stderr.slice(0, 200) || 'exit ' + result.exitCode}`,
      contentHash: hashOf(result.stderr),
    };
  }
  const changed = result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const violations = changed.filter(
    (path) => !allowed.some((prefix) => isUnder(path, prefix))
  );
  const passed = violations.length === 0;
  return {
    passed,
    evidence: passed
      ? `${changed.length} changed files, all under allowlist`
      : `${violations.length} files outside allowlist: ${violations.slice(0, 3).join(', ')}${violations.length > 3 ? '…' : ''}`,
    contentHash: hashOf(changed.sort().join('\n')),
  };
}

// --- helpers -----------------------------------------------------------

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function hashOf(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function failResult(spec, error, evidence) {
  return {
    id: spec?.id ?? 'unknown',
    type: spec?.type ?? 'unknown',
    passed: false,
    evidence,
    error,
  };
}

function resolveCwd(spec, ctx) {
  let candidate = spec.cwd ?? ctx.cwd ?? process.cwd();
  candidate = resolve(candidate);
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function isUnder(path, prefix) {
  if (path === prefix) return true;
  if (prefix.endsWith('/')) return path.startsWith(prefix);
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + sep);
}

// --- aggregate roll-up -------------------------------------------------

// Roll a list of results into a ValidationStatus per src/types.ts.
//
// Phase 9.3 — deterministic and judge bands roll up separately. A judge
// result alone NEVER produces 'verified'; it can only land on the
// judged_ok / judged_concerns band. When both bands have results,
// deterministic dominates the verdict and judge concerns are recorded
// alongside (callers can render both badges).
//
// Behavior:
//   - empty                                     → 'unverified'
//   - all deterministic pass, no judge          → 'verified'
//   - all deterministic pass, all judge ok      → 'verified'
//   - all deterministic pass, judge concerns    → 'judged_concerns'
//   - deterministic mixed                       → 'partially_verified'
//   - deterministic all fail, judge any         → 'failed'
//   - no deterministic, all judge ok            → 'judged_ok'
//   - no deterministic, any judge concerns      → 'judged_concerns'
export function rollupValidationStatus(results) {
  if (!Array.isArray(results) || results.length === 0) return 'unverified';

  const det = [];
  const judge = [];
  for (const r of results) {
    const band = r.band || bandFor(r.type) || 'deterministic';
    if (band === 'judge') judge.push(r);
    else det.push(r);
  }

  const detPass = det.filter((r) => r.passed).length;
  const detTotal = det.length;
  const judgeAllOk = judge.length > 0 && judge.every((r) => r.passed);
  const judgeAnyConcerns = judge.some((r) => !r.passed);

  if (detTotal === 0) {
    if (judge.length === 0) return 'unverified';
    return judgeAllOk ? 'judged_ok' : 'judged_concerns';
  }

  if (detPass === detTotal) {
    if (judge.length === 0 || judgeAllOk) return 'verified';
    if (judgeAnyConcerns) return 'judged_concerns';
    return 'verified';
  }

  if (detPass === 0) return 'failed';
  return 'partially_verified';
}
