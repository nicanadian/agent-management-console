import { describe, it, expect } from 'vitest';
import { parseCapture } from './parseCapture';

describe('parseCapture', () => {
  it('plain text becomes the title', () => {
    expect(parseCapture('investigate flaky test')).toEqual({
      title: 'investigate flaky test',
      agentId: undefined,
      project: undefined,
      priority: undefined,
    });
  });

  it('extracts @agent', () => {
    expect(parseCapture('@coding-agent fix bug').agentId).toBe('coding-agent');
    expect(parseCapture('@coding-agent fix bug').title).toBe('fix bug');
  });

  it('extracts #project', () => {
    expect(parseCapture('#orbital-sim do thing').project).toBe('orbital-sim');
  });

  it('extracts !priority', () => {
    expect(parseCapture('!high something').priority).toBe('high');
  });

  it('rejects invalid priority', () => {
    expect(parseCapture('!nope something').priority).toBeUndefined();
  });

  it('parses all three plus title', () => {
    expect(
      parseCapture('@coding-agent #orbital-sim !high investigate flaky test')
    ).toEqual({
      title: 'investigate flaky test',
      agentId: 'coding-agent',
      project: 'orbital-sim',
      priority: 'high',
    });
  });

  it('order does not matter', () => {
    expect(
      parseCapture('investigate !high @coding-agent flaky test #orbital-sim')
    ).toEqual({
      title: 'investigate flaky test',
      agentId: 'coding-agent',
      project: 'orbital-sim',
      priority: 'high',
    });
  });

  it('last @agent wins on duplicates', () => {
    expect(parseCapture('@a @b foo').agentId).toBe('b');
  });

  it('bare @ or # or ! is not a token', () => {
    expect(parseCapture('@ # ! word')).toEqual({
      title: '@ # ! word',
      agentId: undefined,
      project: undefined,
      priority: undefined,
    });
  });

  it('empty input returns empty title', () => {
    expect(parseCapture('   ').title).toBe('');
  });
});
