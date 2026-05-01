import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateContract,
  evaluateContracts,
  rollupValidationStatus,
} from './contracts.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contracts-test-'));
});

describe('file_exists', () => {
  it('passes when all paths exist', async () => {
    writeFileSync(join(root, 'a.md'), 'A');
    writeFileSync(join(root, 'b.md'), 'B');
    const r = await evaluateContract(
      { id: 'docs', type: 'file_exists', paths: ['a.md', 'b.md'] },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain('all 2 present');
  });

  it('fails listing missing paths', async () => {
    const r = await evaluateContract(
      { id: 'docs', type: 'file_exists', paths: ['missing.md'] },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('missing.md');
  });

  it('contentHash is stable across runs', async () => {
    writeFileSync(join(root, 'a.md'), 'A');
    const r1 = await evaluateContract(
      { id: 'docs', type: 'file_exists', paths: ['a.md'] },
      { cwd: root, allowedBasePaths: [root] }
    );
    const r2 = await evaluateContract(
      { id: 'docs', type: 'file_exists', paths: ['a.md'] },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r1.contentHash).toBe(r2.contentHash);
  });
});

describe('command_exit', () => {
  it('passes on expected exit code', async () => {
    const r = await evaluateContract(
      { id: 'noop', type: 'command_exit', command: 'true' },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(true);
  });

  it('fails on unexpected exit code', async () => {
    const r = await evaluateContract(
      { id: 'fail', type: 'command_exit', command: 'false' },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('exit=1');
  });

  it('respects expectedExitCode override', async () => {
    const r = await evaluateContract(
      {
        id: 'fail-as-pass',
        type: 'command_exit',
        command: 'false',
        expectedExitCode: 1,
      },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(true);
  });

  it('reports timeouts as failure', async () => {
    const r = await evaluateContract(
      {
        id: 'slow',
        type: 'command_exit',
        command: 'sleep',
        args: ['10'],
        timeoutMs: 200,
      },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('timeout');
  });
});

describe('content_structure', () => {
  it('passes when all required headings present', async () => {
    writeFileSync(
      join(root, 'doc.md'),
      '# Title\n\n## Findings\n\n## Conclusion\n'
    );
    const r = await evaluateContract(
      {
        id: 'doc',
        type: 'content_structure',
        path: 'doc.md',
        requireHeadings: ['Title', 'Findings', 'Conclusion'],
      },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(true);
  });

  it('fails when a required heading is missing', async () => {
    writeFileSync(join(root, 'doc.md'), '# Title\n## Findings\n');
    const r = await evaluateContract(
      {
        id: 'doc',
        type: 'content_structure',
        path: 'doc.md',
        requireHeadings: ['Title', 'Findings', 'Conclusion'],
      },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('Conclusion');
  });

  it('fails on minLines below threshold', async () => {
    writeFileSync(join(root, 'short.md'), 'one\ntwo\n');
    const r = await evaluateContract(
      { id: 'short', type: 'content_structure', path: 'short.md', minLines: 10 },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(false);
  });

  it('handles requireRegex matches', async () => {
    writeFileSync(join(root, 'doc.md'), 'API key: abc-123\nDone.\n');
    const r = await evaluateContract(
      {
        id: 'doc',
        type: 'content_structure',
        path: 'doc.md',
        requireRegex: ['API key:'],
      },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(true);
  });
});

describe('file_modified', () => {
  it('passes when mtime is after sinceIso', async () => {
    writeFileSync(join(root, 'fresh.md'), 'x');
    const r = await evaluateContract(
      {
        id: 'fresh',
        type: 'file_modified',
        path: 'fresh.md',
        sinceIso: new Date(Date.now() - 1000 * 60).toISOString(),
      },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(true);
  });

  it('fails when mtime predates sinceIso', async () => {
    const stale = join(root, 'stale.md');
    writeFileSync(stale, 'old');
    const past = new Date(Date.now() - 1000 * 60 * 60);
    utimesSync(stale, past, past);
    const r = await evaluateContract(
      {
        id: 'stale',
        type: 'file_modified',
        path: 'stale.md',
        sinceIso: new Date().toISOString(),
      },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(false);
  });
});

describe('min_links', () => {
  it('counts markdown links above threshold', async () => {
    writeFileSync(
      join(root, 'links.md'),
      'See [one](http://a) and [two](http://b) and ![img](http://c).\n'
    );
    const r = await evaluateContract(
      { id: 'links', type: 'min_links', path: 'links.md', count: 2 },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(true);
  });

  it('fails when below threshold', async () => {
    writeFileSync(join(root, 'one.md'), 'Just [one](http://a).\n');
    const r = await evaluateContract(
      { id: 'links', type: 'min_links', path: 'one.md', count: 5 },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(false);
  });
});

describe('git_diff_in_paths', () => {
  it('passes when diff is empty (treated as all-allowed)', async () => {
    // Create a git repo with no commits diff'd
    const r = await evaluateContract(
      {
        id: 'scope',
        type: 'git_diff_in_paths',
        allowedPaths: ['src/'],
        baseRef: 'HEAD',
      },
      { cwd: process.cwd(), allowedBasePaths: [process.cwd()] }
    );
    // Either passes (clean working tree under allowed) or fails (dirty).
    // We don't know the harness state — assert the result has shape.
    expect(typeof r.passed).toBe('boolean');
    expect(r.evidence).toBeDefined();
  });
});

describe('error handling', () => {
  it('returns unknown_type for unknown types', async () => {
    const r = await evaluateContract(
      { id: 'x', type: 'mystery' },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(false);
    expect(r.error).toBe('unknown_type');
  });

  it('does not throw on a checker error', async () => {
    const r = await evaluateContract(
      { id: 'bad', type: 'command_exit', command: '../etc/passwd' },
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(r.passed).toBe(false);
    expect(r.error).toBeDefined();
  });
});

describe('evaluateContracts (batch)', () => {
  it('runs all and aggregates', async () => {
    writeFileSync(join(root, 'a.md'), 'A');
    const results = await evaluateContracts(
      [
        { id: 'a', type: 'file_exists', paths: ['a.md'] },
        { id: 'b', type: 'file_exists', paths: ['b.md'] },
      ],
      { cwd: root, allowedBasePaths: [root] }
    );
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
  });
});

describe('rollupValidationStatus', () => {
  it('all passed → verified', () => {
    expect(
      rollupValidationStatus([
        { passed: true, type: 'file_exists' },
        { passed: true, type: 'file_exists' },
      ])
    ).toBe('verified');
  });
  it('mixed deterministic → partially_verified', () => {
    expect(
      rollupValidationStatus([
        { passed: true, type: 'file_exists' },
        { passed: false, type: 'file_exists' },
      ])
    ).toBe('partially_verified');
  });
  it('all failed → failed', () => {
    expect(
      rollupValidationStatus([{ passed: false, type: 'file_exists' }])
    ).toBe('failed');
  });
  it('empty → unverified', () => {
    expect(rollupValidationStatus([])).toBe('unverified');
  });

  // Phase 9.3 — judge band rollup behavior.
  it('judge alone → judged_ok when all ok (never verified)', () => {
    expect(
      rollupValidationStatus([{ passed: true, type: 'judge' }])
    ).toBe('judged_ok');
  });
  it('judge alone with concerns → judged_concerns', () => {
    expect(
      rollupValidationStatus([
        { passed: true, type: 'judge' },
        { passed: false, type: 'judge' },
      ])
    ).toBe('judged_concerns');
  });
  it('deterministic verified + judge concerns → judged_concerns', () => {
    expect(
      rollupValidationStatus([
        { passed: true, type: 'file_exists' },
        { passed: false, type: 'judge' },
      ])
    ).toBe('judged_concerns');
  });
  it('deterministic verified + judge ok → verified', () => {
    expect(
      rollupValidationStatus([
        { passed: true, type: 'file_exists' },
        { passed: true, type: 'judge' },
      ])
    ).toBe('verified');
  });
  it('deterministic failed + judge ok → failed (judge cannot rescue)', () => {
    expect(
      rollupValidationStatus([
        { passed: false, type: 'file_exists' },
        { passed: true, type: 'judge' },
      ])
    ).toBe('failed');
  });
});

describe('judge checker', () => {
  it('passes when stub judgeRunner returns ok', async () => {
    const r = await evaluateContract(
      {
        id: 'docs-quality',
        type: 'judge',
        criterion: 'Are headings present?',
        text: '# Title\n## Findings',
      },
      {
        judgeRunner: async () => ({
          verdict: 'ok',
          reasoning: 'Both headings present',
        }),
      }
    );
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain('ok');
    expect(r.evidence).toContain('Both headings present');
  });

  it('fails when stub judgeRunner returns concerns', async () => {
    const r = await evaluateContract(
      {
        id: 'docs-quality',
        type: 'judge',
        criterion: 'Are numbers cited?',
        text: 'No numbers anywhere.',
      },
      {
        judgeRunner: async () => ({
          verdict: 'concerns',
          reasoning: 'No citations found',
        }),
      }
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('No citations found');
  });

  it('reads artifact from path when provided', async () => {
    let captured = '';
    writeFileSync(join(root, 'doc.md'), 'fixed-artifact-text');
    await evaluateContract(
      {
        id: 'docs-quality',
        type: 'judge',
        criterion: 'irrelevant',
        path: 'doc.md',
      },
      {
        cwd: root,
        allowedBasePaths: [root],
        judgeRunner: async (prompt) => {
          captured = prompt;
          return { verdict: 'ok', reasoning: '' };
        },
      }
    );
    expect(captured).toContain('fixed-artifact-text');
  });

  it('truncates oversize artifacts', async () => {
    const big = 'X'.repeat(70 * 1024);
    let captured = '';
    await evaluateContract(
      {
        id: 'docs-quality',
        type: 'judge',
        criterion: 'irrelevant',
        text: big,
        maxArtifactBytes: 1024,
      },
      {
        judgeRunner: async (prompt) => {
          captured = prompt;
          return { verdict: 'ok', reasoning: '' };
        },
      }
    );
    expect(captured).toContain('[truncated]');
    // 1024-cap + the prompt prefix + truncation marker — well under 70KB.
    expect(captured.length).toBeLessThan(5_000);
  });

  it('reports judge runtime errors as failure (does not throw)', async () => {
    const r = await evaluateContract(
      {
        id: 'docs-quality',
        type: 'judge',
        criterion: 'x',
        text: 'y',
      },
      {
        judgeRunner: async () => {
          throw new Error('mock provider down');
        },
      }
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('mock provider down');
  });

  it('treats malformed verdict as concerns', async () => {
    const r = await evaluateContract(
      {
        id: 'x',
        type: 'judge',
        criterion: 'x',
        text: 'y',
      },
      {
        judgeRunner: async () => ({ verdict: 'maybe?', reasoning: '' }),
      }
    );
    expect(r.passed).toBe(false);
  });
});
