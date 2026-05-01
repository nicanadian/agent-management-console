import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DetailPanel } from './DetailPanel';
import { useStore } from '../store';
import { useUIStore } from '../uiStore';
import type { Task } from '../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't',
    title: 'Test task',
    type: 'coding',
    priority: 'normal',
    lifecycleStatus: 'inbox',
    claimedStatus: 'none',
    validationStatus: 'not_applicable',
    reviewStatus: 'not_required',
    createdAt: '2026-04-29T00:00:00Z',
    updatedAt: '2026-04-29T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  useStore.setState({ tasks: [], agents: [], loading: false });
  useUIStore.setState({
    selectedTaskId: null,
    capturePaletteOpen: false,
    shortcutsOverlayOpen: false,
  });
});

describe('DetailPanel — bucket → view routing', () => {
  it('renders nothing when no task is selected', () => {
    const { container } = render(<DetailPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('routes running bucket → RunningView (Stop / Cancel buttons)', () => {
    const t = makeTask({ id: 't1', lifecycleStatus: 'running' });
    useStore.setState({ tasks: [t], agents: [] });
    useUIStore.setState({ selectedTaskId: 't1' });
    render(<DetailPanel />);
    expect(screen.getByText('Stop after current tool')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('routes review bucket → ReviewView (Accept + Request changes)', () => {
    const t = makeTask({
      id: 't1',
      lifecycleStatus: 'done',
      claimedStatus: 'succeeded',
      reviewStatus: 'pending',
      validationStatus: 'verified',
    });
    useStore.setState({ tasks: [t], agents: [] });
    useUIStore.setState({ selectedTaskId: 't1' });
    render(<DetailPanel />);
    expect(screen.getByText('Accept')).toBeInTheDocument();
    expect(screen.getByText('Request changes')).toBeInTheDocument();
  });

  it('routes failed bucket → FailedView (no Accept button)', () => {
    const t = makeTask({
      id: 't1',
      lifecycleStatus: 'done',
      claimedStatus: 'succeeded',
      validationStatus: 'failed',
      reviewStatus: 'pending',
    });
    useStore.setState({ tasks: [t], agents: [] });
    useUIStore.setState({ selectedTaskId: 't1' });
    render(<DetailPanel />);
    expect(screen.queryByText('Accept')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop after current tool')).not.toBeInTheDocument();
  });

  it('routes inbox bucket → InboxView (assign-to-agent picker)', () => {
    const t = makeTask({ id: 't1', lifecycleStatus: 'inbox' });
    useStore.setState({
      tasks: [t],
      agents: [
        {
          id: 'coding-agent',
          name: 'coding-agent',
          model: 'sonnet',
          role: 'code',
          status: 'available',
          activeTasks: 0,
        },
      ],
    });
    useUIStore.setState({ selectedTaskId: 't1' });
    render(<DetailPanel />);
    expect(screen.getByText('Assign to agent')).toBeInTheDocument();
    expect(screen.getByText('coding-agent')).toBeInTheDocument();
  });

  it('routes done/accepted bucket → SimpleView (no actions)', () => {
    const t = makeTask({
      id: 't1',
      lifecycleStatus: 'done',
      claimedStatus: 'succeeded',
      reviewStatus: 'accepted',
    });
    useStore.setState({ tasks: [t], agents: [] });
    useUIStore.setState({ selectedTaskId: 't1' });
    render(<DetailPanel />);
    expect(screen.queryByText('Accept')).not.toBeInTheDocument();
    expect(screen.queryByText('Request changes')).not.toBeInTheDocument();
    expect(screen.queryByText('Assign to agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop after current tool')).not.toBeInTheDocument();
  });
});
