import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock @forge/bridge
// ---------------------------------------------------------------------------
jest.mock('@forge/bridge', () => ({
  __esModule: true,
  invoke: jest.fn(),
  view: { getContext: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Mock @forge/react UI Kit components → plain HTML for assertions.
// ---------------------------------------------------------------------------
jest.mock('@forge/react', () => {
  const actual = jest.requireActual('react');
  return {
    __esModule: true,
    default: { render: jest.fn() },
    Button: ({
      children,
      onClick,
      isDisabled,
    }: {
      children?: React.ReactNode;
      onClick?: () => void;
      isDisabled?: boolean;
    }) => actual.createElement('button', { onClick, disabled: isDisabled }, children),
    Heading: ({ children }: { children?: React.ReactNode }) =>
      actual.createElement('h3', null, children),
    Label: ({ children }: { children?: React.ReactNode }) =>
      actual.createElement('label', null, children),
    SectionMessage: ({
      children,
      title,
    }: {
      children?: React.ReactNode;
      title?: string;
    }) => actual.createElement('div', { 'data-title': title }, children),
    Select: ({
      options,
      onChange,
    }: {
      options?: Array<{ label: string; value: string }>;
      onChange?: (e: { label: string; value: string }) => void;
    }) =>
      actual.createElement(
        'select',
        {
          'data-testid': 'repo-select',
          onChange: (ev: React.ChangeEvent<HTMLSelectElement>) => {
            const value = ev.target.value;
            const opt = (options ?? []).find((o) => o.value === value);
            if (onChange && opt) onChange(opt);
          },
        },
        (options ?? []).map((o) =>
          actual.createElement('option', { key: o.value, value: o.value }, o.label),
        ),
      ),
    Spinner: ({ label }: { label?: string }) =>
      actual.createElement('div', null, label ?? 'loading'),
    Stack: ({ children }: { children?: React.ReactNode }) =>
      actual.createElement('div', null, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      actual.createElement('span', null, children),
    Textfield: ({
      value,
      onChange,
    }: {
      value?: string;
      onChange?: (e: { target: { value: string } }) => void;
    }) =>
      actual.createElement('input', {
        'data-testid': 'branch-field',
        value: value ?? '',
        onChange: (ev: React.ChangeEvent<HTMLInputElement>) =>
          onChange && onChange({ target: { value: ev.target.value } }),
      }),
  };
});

import { DispatchPanel } from '../dispatchPanel';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bridgeMock = jest.requireMock('@forge/bridge') as any;
const mockInvoke: jest.Mock = bridgeMock.invoke;
const mockGetContext: jest.Mock = bridgeMock.view.getContext;

beforeEach(() => {
  mockInvoke.mockReset();
  mockGetContext.mockReset();
  mockGetContext.mockResolvedValue({ extension: { issue: { key: 'PROJ-7' } } });
});

/** Configures invoke() to answer the panel's load + dispatch calls. */
function wireInvoke(dispatchResult?: unknown): void {
  mockInvoke.mockImplementation((key: string) => {
    if (key === 'getJiraContext') {
      return Promise.resolve({
        issueKey: 'PROJ-7',
        suggestedBranch: 'PROJ-7-fix-the-login-bug',
      });
    }
    if (key === 'fetchRepositories') {
      return Promise.resolve([
        { workspace: 'ws', repoSlug: 'repo-a', fullName: 'ws/repo-a' },
      ]);
    }
    if (key === 'dispatchAgent') {
      return Promise.resolve(
        dispatchResult ?? {
          success: true,
          message: 'Agent pipeline started on branch PROJ-7-fix-the-login-bug.',
          branch: 'PROJ-7-fix-the-login-bug',
          buildUrl: 'https://bitbucket.org/ws/repo-a/pipelines/results/42',
        },
      );
    }
    return Promise.resolve(undefined);
  });
}

describe('DispatchPanel', () => {
  it('loads the issue context and pre-fills the suggested branch', async () => {
    wireInvoke();
    await act(async () => {
      render(<DispatchPanel />);
    });

    await waitFor(() => {
      expect(screen.getByText(/Issue PROJ-7/)).toBeInTheDocument();
    });
    const branchField = screen.getByTestId('branch-field') as HTMLInputElement;
    expect(branchField.value).toBe('PROJ-7-fix-the-login-bug');
  });

  it('dispatches the agent and shows the returned pipeline link', async () => {
    wireInvoke();
    await act(async () => {
      render(<DispatchPanel />);
    });
    await waitFor(() => screen.getByTestId('repo-select'));

    // Choose a repository, then dispatch.
    await act(async () => {
      fireEvent.change(screen.getByTestId('repo-select'), {
        target: { value: 'ws/repo-a' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Dispatch agent'));
    });

    await waitFor(() => {
      expect(screen.getByText(/pipelines\/results\/42/)).toBeInTheDocument();
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      'dispatchAgent',
      expect.objectContaining({
        workspace: 'ws',
        repoSlug: 'repo-a',
        issueKey: 'PROJ-7',
        branch: 'PROJ-7-fix-the-login-bug',
      }),
    );
  });

  it('shows an error message when dispatch fails', async () => {
    wireInvoke({ success: false, message: 'Failed to trigger pipeline: 500' });
    await act(async () => {
      render(<DispatchPanel />);
    });
    await waitFor(() => screen.getByTestId('repo-select'));

    await act(async () => {
      fireEvent.change(screen.getByTestId('repo-select'), {
        target: { value: 'ws/repo-a' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Dispatch agent'));
    });

    await waitFor(() => {
      expect(screen.getByText(/Failed to trigger pipeline/)).toBeInTheDocument();
    });
  });
});
