import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRepository } from './__fixtures__/inMemoryRepository';
import type { Task, Agent } from '../types';

function seedTasks(): Task[] {
  return [
    {
      id: 't-running',
      title: 'A running task',
      type: 'coding',
      priority: 'normal',
      agentId: 'coding-agent',
      lifecycleStatus: 'running',
      claimedStatus: 'none',
      validationStatus: 'pending',
      reviewStatus: 'pending',
      createdAt: '2026-04-28T00:00:00Z',
      updatedAt: '2026-04-28T00:00:00Z',
    },
    {
      id: 't-running-waiting',
      title: 'Running and waiting on user',
      type: 'coding',
      priority: 'normal',
      agentId: 'coding-agent',
      lifecycleStatus: 'running',
      claimedStatus: 'none',
      validationStatus: 'pending',
      reviewStatus: 'pending',
      waitingOnUser: true,
      createdAt: '2026-04-28T00:00:00Z',
      updatedAt: '2026-04-28T00:00:00Z',
    },
    {
      id: 't-review',
      title: 'A task in review',
      type: 'docs',
      priority: 'normal',
      agentId: 'docs-agent',
      lifecycleStatus: 'done',
      claimedStatus: 'succeeded',
      validationStatus: 'verified',
      reviewStatus: 'pending',
      createdAt: '2026-04-28T00:00:00Z',
      updatedAt: '2026-04-28T00:00:00Z',
    },
    {
      id: 't-inbox',
      title: 'A captured task',
      type: 'analysis',
      priority: 'normal',
      lifecycleStatus: 'inbox',
      claimedStatus: 'none',
      validationStatus: 'not_applicable',
      reviewStatus: 'not_required',
      createdAt: '2026-04-28T00:00:00Z',
      updatedAt: '2026-04-28T00:00:00Z',
    },
  ];
}

function seedAgents(): Agent[] {
  return [
    {
      id: 'coding-agent',
      name: 'coding-agent',
      model: 'Sonnet',
      role: 'Code',
      status: 'busy',
      activeTasks: 1,
    },
  ];
}

let repo: InMemoryRepository;
beforeEach(() => {
  repo = new InMemoryRepository({ tasks: seedTasks(), agents: seedAgents() });
});

describe('listTasks / listAgents / getTask', () => {
  it('lists seeded tasks', async () => {
    const tasks = await repo.listTasks();
    expect(tasks).toHaveLength(4);
    expect(tasks.map((t) => t.id)).toEqual([
      't-running',
      't-running-waiting',
      't-review',
      't-inbox',
    ]);
  });

  it('lists seeded agents', async () => {
    const agents = await repo.listAgents();
    expect(agents).toHaveLength(1);
  });

  it('getTask returns the matching task', async () => {
    const t = await repo.getTask('t-review');
    expect(t?.title).toBe('A task in review');
  });

  it('getTask returns undefined for unknown id', async () => {
    expect(await repo.getTask('nope')).toBeUndefined();
  });

  it('listTasks returns a fresh array each call (no shared mutation)', async () => {
    const a = await repo.listTasks();
    const b = await repo.listTasks();
    expect(a).not.toBe(b);
  });
});

describe('captureTask', () => {
  it('creates an inbox task with default fields', async () => {
    const task = await repo.captureTask({ title: 'Write up the postmortem' });
    expect(task.lifecycleStatus).toBe('inbox');
    expect(task.claimedStatus).toBe('none');
    expect(task.validationStatus).toBe('not_applicable');
    expect(task.reviewStatus).toBe('not_required');
    expect(task.title).toBe('Write up the postmortem');
    expect(task.agentId).toBeUndefined();
  });

  it('prepends the new task to the list', async () => {
    await repo.captureTask({ title: 'New task' });
    const tasks = await repo.listTasks();
    expect(tasks[0].title).toBe('New task');
    expect(tasks).toHaveLength(5);
  });
});

describe('assignTask', () => {
  it('sets agent and moves to queued', async () => {
    const updated = await repo.assignTask('t-inbox', 'coding-agent');
    expect(updated?.agentId).toBe('coding-agent');
    expect(updated?.lifecycleStatus).toBe('queued');
    expect(updated?.reviewStatus).toBe('pending');
  });

  it('returns undefined for unknown task', async () => {
    expect(await repo.assignTask('nope', 'coding-agent')).toBeUndefined();
  });
});

describe('acceptTask', () => {
  it('sets reviewStatus to accepted and clears waitingOnUser', async () => {
    const updated = await repo.acceptTask('t-review');
    expect(updated?.reviewStatus).toBe('accepted');
    expect(updated?.waitingOnUser).toBe(false);
    expect(updated?.lifecycleStatus).toBe('done');
  });
});

describe('rejectTask', () => {
  it('sends back to queued with needs_changes and resets claim/validation', async () => {
    const updated = await repo.rejectTask('t-review');
    expect(updated?.lifecycleStatus).toBe('queued');
    expect(updated?.reviewStatus).toBe('needs_changes');
    expect(updated?.claimedStatus).toBe('none');
    expect(updated?.validationStatus).toBe('not_applicable');
  });
});

describe('sendMessage', () => {
  it('mode=auto + running + not waiting → queues the reply', async () => {
    const updated = await repo.sendMessage('t-running', 'try this', 'auto');
    expect(updated?.pendingReply?.text).toBe('try this');
    expect(updated?.messages?.length ?? 0).toBe(0);
  });

  it('mode=auto + running + waiting on user → sends immediately', async () => {
    const updated = await repo.sendMessage(
      't-running-waiting',
      'reply text',
      'auto'
    );
    expect(updated?.pendingReply).toBeUndefined();
    expect(updated?.messages?.length).toBe(1);
    expect(updated?.messages?.[0].from).toBe('user');
    expect(updated?.messages?.[0].text).toBe('reply text');
    expect(updated?.waitingOnUser).toBe(false);
  });

  it('mode=queue → always queues, even when waiting', async () => {
    const updated = await repo.sendMessage(
      't-running-waiting',
      'queued msg',
      'queue'
    );
    expect(updated?.pendingReply?.text).toBe('queued msg');
    expect(updated?.messages?.length ?? 0).toBe(0);
  });

  it('mode=interrupt → sends immediately even when running', async () => {
    const updated = await repo.sendMessage('t-running', 'stop now', 'interrupt');
    expect(updated?.pendingReply).toBeUndefined();
    expect(updated?.messages?.length).toBe(1);
    expect(updated?.messages?.[0].text).toBe('stop now');
  });

  it('replying to a review task restarts it: lifecycle → running, claim → none, validation → pending', async () => {
    const updated = await repo.sendMessage(
      't-review',
      'add citations please',
      'auto'
    );
    expect(updated?.lifecycleStatus).toBe('running');
    expect(updated?.claimedStatus).toBe('none');
    expect(updated?.validationStatus).toBe('pending');
    expect(updated?.messages?.length).toBe(1);
  });
});

describe('subscribe', () => {
  it('fires listeners on mutation', async () => {
    let notified = 0;
    repo.subscribe(() => {
      notified++;
    });
    await repo.captureTask({ title: 'a' });
    await repo.assignTask('t-inbox', 'coding-agent');
    expect(notified).toBe(2);
  });

  it('unsubscribe stops further notifications', async () => {
    let notified = 0;
    const off = repo.subscribe(() => {
      notified++;
    });
    await repo.captureTask({ title: 'a' });
    off();
    await repo.captureTask({ title: 'b' });
    expect(notified).toBe(1);
  });

  it('listeners receive a snapshot reflecting the latest state', async () => {
    let lastTaskCount = 0;
    repo.subscribe((snap: { tasks: unknown[] }) => {
      lastTaskCount = snap.tasks.length;
    });
    await repo.captureTask({ title: 'a' });
    expect(lastTaskCount).toBe(5);
  });
});
