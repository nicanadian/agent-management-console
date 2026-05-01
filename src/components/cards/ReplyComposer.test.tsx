import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReplyComposer } from './ReplyComposer';
import { useStore } from '../../store';
import type { Task } from '../../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't',
    title: 'Test',
    type: 'coding',
    priority: 'normal',
    lifecycleStatus: 'running',
    claimedStatus: 'none',
    validationStatus: 'pending',
    reviewStatus: 'pending',
    createdAt: '2026-04-29T00:00:00Z',
    updatedAt: '2026-04-29T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  useStore.setState({ tasks: [], agents: [], loading: false });
});

describe('ReplyComposer — mode-switching', () => {
  it('button label is "Send" when task is not running', () => {
    const t = makeTask({ lifecycleStatus: 'blocked' });
    render(<ReplyComposer task={t} messageCount={0} />);
    fireEvent.change(screen.getByPlaceholderText(/Message/), {
      target: { value: 'hi' },
    });
    expect(screen.getByText('Send')).toBeInTheDocument();
  });

  it('button label is "Queue" when running and not waiting', () => {
    const t = makeTask({ lifecycleStatus: 'running', waitingOnUser: false });
    render(<ReplyComposer task={t} messageCount={0} />);
    fireEvent.change(screen.getByPlaceholderText(/Queue reply/), {
      target: { value: 'hi' },
    });
    expect(screen.getByText('Queue')).toBeInTheDocument();
  });

  it('button label is "Send" when running and waiting on user', () => {
    const t = makeTask({ lifecycleStatus: 'running', waitingOnUser: true });
    render(<ReplyComposer task={t} messageCount={0} />);
    fireEvent.change(screen.getByPlaceholderText(/Reply/), {
      target: { value: 'hi' },
    });
    expect(screen.getByText('Send')).toBeInTheDocument();
  });

  it('button label is "Replace" when there is a pendingReply and not waiting', () => {
    const t = makeTask({
      lifecycleStatus: 'running',
      waitingOnUser: false,
      pendingReply: { text: 'queued', queuedAt: '2026-04-29T00:00:00Z' },
    });
    render(<ReplyComposer task={t} messageCount={1} />);
    fireEvent.change(screen.getByPlaceholderText(/Queue reply/), {
      target: { value: 'override' },
    });
    expect(screen.getByText('Replace')).toBeInTheDocument();
  });

  it('button is disabled when input is empty', () => {
    const t = makeTask({ lifecycleStatus: 'blocked' });
    render(<ReplyComposer task={t} messageCount={0} />);
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button).toBeDisabled();
  });

  it('placeholder reads "Reply…" when waiting on user', () => {
    const t = makeTask({ lifecycleStatus: 'running', waitingOnUser: true });
    render(<ReplyComposer task={t} messageCount={0} />);
    expect(screen.getByPlaceholderText('Reply…')).toBeInTheDocument();
  });

  it('placeholder reads "Queue reply…" when running and not waiting', () => {
    const t = makeTask({ lifecycleStatus: 'running', waitingOnUser: false });
    render(<ReplyComposer task={t} messageCount={0} />);
    expect(screen.getByPlaceholderText('Queue reply…')).toBeInTheDocument();
  });

  it('placeholder reads "Message…" when not running', () => {
    const t = makeTask({ lifecycleStatus: 'blocked' });
    render(<ReplyComposer task={t} messageCount={0} />);
    expect(screen.getByPlaceholderText('Message…')).toBeInTheDocument();
  });
});
