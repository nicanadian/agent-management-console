// Contract sandbox — runs agent-authored commands for `command_exit`
// validation contracts. The contract YAML is agent-authored, so the runner
// is unconstrained RCE without these guards.
//
// Constraints applied:
//   1. cwd MUST resolve under one of the allowed base paths (defaults to
//      the repo root). Symlinks are resolved before the check.
//   2. env is whitelisted — only the keys listed in DEFAULT_ENV_ALLOW pass
//      through, plus any explicit additions. No PATH inheritance unless
//      asked; we provide a minimal default PATH instead.
//   3. The command runs with shell=false (argv form), so shell metachars
//      in arguments don't reinterpret.
//   4. Hard timeout via SIGTERM, then SIGKILL after a 1s grace.
//   5. stdout/stderr are size-capped to 256KB; excess is truncated and
//      reported.
//
// This module is deliberately the only chokepoint for spawning processes
// from contract YAML. Validators MUST go through `runSandboxed` — never
// shell out directly.

import { spawn } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const KILL_GRACE_MS = 1000;
const OUTPUT_CAP_BYTES = 256 * 1024;
const DEFAULT_ENV_ALLOW = ['HOME', 'USER', 'LANG', 'LC_ALL', 'TZ'];
const DEFAULT_PATH =
  '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin';

export class SandboxViolation extends Error {
  constructor(reason, detail) {
    super(`sandbox violation: ${reason}${detail ? ` — ${detail}` : ''}`);
    this.reason = reason;
    this.detail = detail;
  }
}

// runSandboxed(spec, options)
//   spec.command:   string, the executable name (no shell)
//   spec.args:      string[] (optional)
//   spec.cwd:       string, must resolve under options.allowedBasePaths
//   spec.env:       Record<string,string> (optional, additive over allowlist)
//   spec.envAllow:  string[] of additional keys to inherit from process.env
//   spec.timeoutMs: number (default 30000)
//   spec.inheritPath: boolean (default false; if false, uses DEFAULT_PATH)
//
//   options.allowedBasePaths: string[] — cwd must resolve under one of
//                              these (default: [process.cwd()])
//
// Returns { exitCode, stdout, stderr, durationMs, terminationReason,
//          stdoutTruncated, stderrTruncated }
//   terminationReason: 'exit' | 'timeout' | 'killed' | 'spawn_error'
export async function runSandboxed(spec, options = {}) {
  const allowedBasePaths = (options.allowedBasePaths || [process.cwd()]).map(
    (p) => realpathSafe(resolve(p))
  );
  const cwd = realpathSafe(resolve(spec.cwd || process.cwd()));

  if (!cwd) {
    throw new SandboxViolation('cwd_does_not_exist', spec.cwd);
  }
  if (!isUnderAny(cwd, allowedBasePaths)) {
    throw new SandboxViolation(
      'cwd_outside_allowlist',
      `${cwd} not under ${allowedBasePaths.join(', ')}`
    );
  }
  if (typeof spec.command !== 'string' || !spec.command) {
    throw new SandboxViolation('missing_command');
  }
  if (spec.command.includes('/') || spec.command.includes('\\')) {
    throw new SandboxViolation(
      'absolute_or_relative_command',
      'pass a bare executable name; PATH lookup is handled inside the sandbox'
    );
  }

  const env = buildEnv(spec);
  const args = Array.isArray(spec.args) ? spec.args : [];
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const startedAt = Date.now();

  const stdinMode = typeof spec.stdin === 'string' ? 'pipe' : 'ignore';

  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(spec.command, args, {
        cwd,
        env,
        stdio: [stdinMode, 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      resolveRun({
        exitCode: null,
        stdout: '',
        stderr: String(err.message || err),
        durationMs: Date.now() - startedAt,
        terminationReason: 'spawn_error',
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let terminationReason = 'exit';

    const captureChunk = (which, chunk) => {
      const s = chunk.toString();
      if (which === 'stdout') {
        if (stdout.length + s.length > OUTPUT_CAP_BYTES) {
          stdout += s.slice(0, OUTPUT_CAP_BYTES - stdout.length);
          stdoutTruncated = true;
        } else {
          stdout += s;
        }
      } else {
        if (stderr.length + s.length > OUTPUT_CAP_BYTES) {
          stderr += s.slice(0, OUTPUT_CAP_BYTES - stderr.length);
          stderrTruncated = true;
        } else {
          stderr += s;
        }
      }
    };

    child.stdout.on('data', (c) => captureChunk('stdout', c));
    child.stderr.on('data', (c) => captureChunk('stderr', c));

    if (stdinMode === 'pipe' && child.stdin) {
      child.stdin.on('error', () => {
        /* child may close stdin before we finish writing; ignore EPIPE */
      });
      child.stdin.end(spec.stdin);
    }

    const timer = setTimeout(() => {
      terminationReason = 'timeout';
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS).unref();
    }, timeoutMs);
    timer.unref();

    child.on('error', (err) => {
      clearTimeout(timer);
      terminationReason = terminationReason === 'exit' ? 'spawn_error' : terminationReason;
      stderr += `\n[spawn error] ${err.message}`;
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal && terminationReason === 'exit') {
        terminationReason = 'killed';
      }
      resolveRun({
        exitCode: code,
        signal: signal || null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        terminationReason,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

function buildEnv(spec) {
  const env = { PATH: spec.inheritPath ? process.env.PATH : DEFAULT_PATH };
  const inheritKeys = new Set([...DEFAULT_ENV_ALLOW, ...(spec.envAllow || [])]);
  for (const k of inheritKeys) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  if (spec.env) {
    for (const [k, v] of Object.entries(spec.env)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  return env;
}

function realpathSafe(path) {
  try {
    return existsSync(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

function isUnderAny(target, bases) {
  for (const base of bases) {
    if (!base) continue;
    if (target === base) return true;
    if (target.startsWith(base + sep)) return true;
  }
  return false;
}
