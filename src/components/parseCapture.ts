import type { CaptureInput } from '../data/repository';
import type { Priority } from '../types';

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

// Parse a capture string into structured CaptureInput.
//
//   @<agent-id>      → input.agentId
//   #<project>       → input.project
//   !<priority>      → input.priority   (low | normal | high | urgent)
//   everything else  → input.title
//
// Multiple of the same prefix → last one wins.
export function parseCapture(raw: string): CaptureInput {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let agentId: string | undefined;
  let project: string | undefined;
  let priority: Priority | undefined;
  const titleTokens: string[] = [];

  for (const tok of tokens) {
    if (tok.startsWith('@') && tok.length > 1) {
      agentId = tok.slice(1);
    } else if (tok.startsWith('#') && tok.length > 1) {
      project = tok.slice(1);
    } else if (tok.startsWith('!') && tok.length > 1) {
      const p = tok.slice(1).toLowerCase() as Priority;
      if (PRIORITIES.includes(p)) priority = p;
    } else {
      titleTokens.push(tok);
    }
  }

  return {
    title: titleTokens.join(' '),
    agentId,
    project,
    priority,
  };
}
