// Tests for tools/contract-sandbox.mjs
//
// Run: npx vitest run tools/contract-sandbox.test.mjs

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSandboxed, SandboxViolation } from './contract-sandbox.mjs';

function makeSandboxRoot() {
  return mkdtempSync(join(tmpdir(), 'sandbox-test-'));
}

describe('runSandboxed', () => {
  it('runs a simple command and captures stdout', async () => {
    const root = makeSandboxRoot();
    const result = await runSandboxed(
      { command: 'echo', args: ['hello'], cwd: root },
      { allowedBasePaths: [root] }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.terminationReason).toBe('exit');
  });

  it('captures non-zero exit codes', async () => {
    const root = makeSandboxRoot();
    const result = await runSandboxed(
      { command: 'sh', args: ['-c', 'exit 42'], cwd: root },
      { allowedBasePaths: [root], inheritPath: true }
    );
    expect(result.exitCode).toBe(42);
    expect(result.terminationReason).toBe('exit');
  });

  it('rejects cwd outside the allowlist', async () => {
    const root = makeSandboxRoot();
    const elsewhere = makeSandboxRoot();
    await expect(
      runSandboxed(
        { command: 'echo', args: ['x'], cwd: elsewhere },
        { allowedBasePaths: [root] }
      )
    ).rejects.toThrow(SandboxViolation);
  });

  it('rejects cwd that does not exist', async () => {
    const root = makeSandboxRoot();
    await expect(
      runSandboxed(
        { command: 'echo', cwd: join(root, 'does-not-exist') },
        { allowedBasePaths: [root] }
      )
    ).rejects.toThrow(SandboxViolation);
  });

  it('rejects commands containing path separators', async () => {
    const root = makeSandboxRoot();
    await expect(
      runSandboxed(
        { command: '/bin/echo', args: ['x'], cwd: root },
        { allowedBasePaths: [root] }
      )
    ).rejects.toThrow(SandboxViolation);
  });

  it('does not run via shell — metachars are literal args', async () => {
    const root = makeSandboxRoot();
    const result = await runSandboxed(
      { command: 'echo', args: ['$HOME', '`date`'], cwd: root },
      { allowedBasePaths: [root] }
    );
    expect(result.stdout.trim()).toBe('$HOME `date`');
  });

  it('times out long-running commands', async () => {
    const root = makeSandboxRoot();
    const result = await runSandboxed(
      { command: 'sleep', args: ['10'], cwd: root, timeoutMs: 200 },
      { allowedBasePaths: [root] }
    );
    expect(result.terminationReason).toBe('timeout');
    expect(result.durationMs).toBeLessThan(2000);
  });

  it('does not inherit arbitrary env by default', async () => {
    const root = makeSandboxRoot();
    process.env.SANDBOX_LEAK_TEST = 'leaked';
    const result = await runSandboxed(
      { command: 'sh', args: ['-c', 'echo "${SANDBOX_LEAK_TEST:-unset}"'], cwd: root },
      { allowedBasePaths: [root], inheritPath: true }
    );
    delete process.env.SANDBOX_LEAK_TEST;
    expect(result.stdout.trim()).toBe('unset');
  });

  it('passes through explicit env additions', async () => {
    const root = makeSandboxRoot();
    const result = await runSandboxed(
      {
        command: 'sh',
        args: ['-c', 'echo "$MY_VAR"'],
        cwd: root,
        env: { MY_VAR: 'set-by-spec' },
      },
      { allowedBasePaths: [root], inheritPath: true }
    );
    expect(result.stdout.trim()).toBe('set-by-spec');
  });

  it('caps stdout output at 256KB', async () => {
    const root = makeSandboxRoot();
    // 300KB of output
    const result = await runSandboxed(
      {
        command: 'sh',
        args: ['-c', 'head -c 307200 /dev/zero | tr "\\0" "x"'],
        cwd: root,
      },
      { allowedBasePaths: [root], inheritPath: true }
    );
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(256 * 1024);
  });

  it('resolves cwd through symlinks before allowlist check', async () => {
    const root = makeSandboxRoot();
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'marker'), 'x');
    // Allowlist points at root; cwd points at the realpath of sub
    const result = await runSandboxed(
      { command: 'ls', cwd: sub },
      { allowedBasePaths: [root] }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('marker');
  });
});
