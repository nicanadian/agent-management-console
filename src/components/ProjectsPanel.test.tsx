import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectsPanel } from './ProjectsPanel';
import { useStore } from '../store';
import { useUIStore } from '../uiStore';

beforeEach(() => {
  useStore.setState({
    tasks: [],
    agents: [],
    projects: [],
    loading: false,
    registerProject: vi.fn(async () => ({ ok: true as const })),
  });
  useUIStore.setState({ projectsPanelOpen: true });
});

describe('ProjectsPanel', () => {
  it('shows an empty state with no projects', () => {
    render(<ProjectsPanel />);
    expect(screen.getByText(/No projects yet/i)).toBeInTheDocument();
  });

  it('lists registered projects with their branch', () => {
    useStore.setState({
      projects: [
        { name: 'my-app', repoPath: '/repos/my-app', defaultBranch: 'main' },
      ],
    });
    render(<ProjectsPanel />);
    expect(screen.getByText('#my-app')).toBeInTheDocument();
    expect(screen.getByText('/repos/my-app')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('submits a registration and clears the form on success', async () => {
    const registerProject = vi.fn(async () => ({ ok: true as const }));
    useStore.setState({ registerProject });
    render(<ProjectsPanel />);

    fireEvent.change(screen.getByPlaceholderText('my-app'), {
      target: { value: 'demo' },
    });
    fireEvent.change(screen.getByPlaceholderText('/Users/you/repos/my-app'), {
      target: { value: '/repos/demo' },
    });
    fireEvent.click(screen.getByText('Register project'));

    await waitFor(() =>
      expect(registerProject).toHaveBeenCalledWith({
        name: 'demo',
        repoPath: '/repos/demo',
        defaultBranch: undefined,
        setupCommand: undefined,
        mergeMode: 'local',
      })
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText('my-app')).toHaveValue('')
    );
  });

  it('surfaces the server error and keeps the form filled on failure', async () => {
    const registerProject = vi.fn(async () => ({
      ok: false as const,
      error: '/nope is not a git work tree',
    }));
    useStore.setState({ registerProject });
    render(<ProjectsPanel />);

    fireEvent.change(screen.getByPlaceholderText('my-app'), {
      target: { value: 'bad' },
    });
    fireEvent.change(screen.getByPlaceholderText('/Users/you/repos/my-app'), {
      target: { value: '/nope' },
    });
    fireEvent.click(screen.getByText('Register project'));

    await waitFor(() =>
      expect(
        screen.getByText('/nope is not a git work tree')
      ).toBeInTheDocument()
    );
    // form keeps its values so the user can correct the path
    expect(screen.getByPlaceholderText('my-app')).toHaveValue('bad');
  });
});
