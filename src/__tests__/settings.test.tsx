import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { SettingsForm } from '../settings';
import { DEFAULT_CONFIG } from '../types';

// ---------------------------------------------------------------------------
// Mock @forge/bridge
// ---------------------------------------------------------------------------

jest.mock('@forge/bridge', () => ({
  __esModule: true,
  invoke: jest.fn(),
  view: {
    getContext: jest.fn(),
  },
}));

// Retrieve stable references after the mock factory has run.
// Using jest.requireMock() avoids hoisting issues with outer `let` variables.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bridgeMock = jest.requireMock('@forge/bridge') as any;
const mockInvoke: jest.Mock = bridgeMock.invoke;
const mockGetContext: jest.Mock = bridgeMock.view.getContext;

// ---------------------------------------------------------------------------
// Mock @forge/react (UI Kit components → render as plain HTML)
// ---------------------------------------------------------------------------

jest.mock('@forge/react', () => {
  const actual = jest.requireActual('react');
  return {
    __esModule: true,
    default: { render: jest.fn() },
    Button: ({ children, type }: { children?: React.ReactNode; type?: string }) =>
      actual.createElement('button', { type }, children),
    Form: ({
      children,
      onSubmit,
    }: {
      children?: React.ReactNode;
      onSubmit?: (data: Record<string, string>) => void;
    }) =>
      actual.createElement(
        'form',
        {
          onSubmit: (e: React.FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (onSubmit) {
              const fd = new FormData(e.currentTarget);
              const data = Object.fromEntries(fd.entries()) as Record<string, string>;
              onSubmit(data);
            }
          },
        },
        children,
      ),
    FormSection: ({ children }: { children?: React.ReactNode }) =>
      actual.createElement('div', null, children),
    Heading: ({ children }: { children?: React.ReactNode }) =>
      actual.createElement('h1', null, children),
    Label: ({ children, labelFor }: { children?: React.ReactNode; labelFor?: string }) =>
      actual.createElement('label', { htmlFor: labelFor }, children),
    SectionMessage: ({
      children,
      title,
    }: {
      children?: React.ReactNode;
      title?: string;
    }) => actual.createElement('div', { 'data-title': title }, children),
    Stack: ({ children }: { children?: React.ReactNode }) =>
      actual.createElement('div', null, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      actual.createElement('span', null, children),
    Textfield: ({
      id,
      name,
      value,
      placeholder,
      onChange,
    }: {
      id?: string;
      name?: string;
      value?: string;
      placeholder?: string;
      onChange?: (e: unknown) => void;
    }) =>
      actual.createElement('input', {
        id,
        name,
        value: value ?? '',
        placeholder,
        onChange,
      }),
    Select: ({
      inputId,
      name,
      value,
    }: {
      inputId?: string;
      name?: string;
      options?: Array<{ label: string; value: string }>;
      value?: { label: string; value: string };
      onChange?: (option: unknown) => void;
    }) =>
      actual.createElement('select', {
        id: inputId,
        name,
        'data-testid': `select-${name ?? inputId}`,
        value: value?.value ?? '',
        readOnly: true,
      }),
    Toggle: ({
      id,
      isChecked,
      onChange,
    }: {
      id?: string;
      isChecked?: boolean;
      onChange?: () => void;
    }) =>
      actual.createElement('input', {
        id,
        type: 'checkbox',
        checked: isChecked ?? false,
        onChange,
        'data-testid': `toggle-${id}`,
      }),
    DynamicTable: ({ head, rows }: { head?: unknown; rows?: unknown[] }) =>
      actual.createElement('table', {
        'data-testid': 'monitoring-table',
        'data-rows': rows ? rows.length : 0,
      }),
    Lozenge: ({ children }: { children?: React.ReactNode }) =>
      actual.createElement('span', { 'data-testid': 'lozenge' }, children),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsForm', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockGetContext.mockReset();
    // Default: view.getContext resolves with a project context.
    mockGetContext.mockResolvedValue({
      extension: {
        project: { uuid: '{proj-uuid-test}' },
      },
    });
    // Default invoke handler that returns appropriate values for each resolver call.
    // getSettings returns the default config; getMonitoringEvents returns no events.
    mockInvoke.mockImplementation((key: string) => {
      if (key === 'getSettings') return Promise.resolve(DEFAULT_CONFIG);
      if (key === 'getMonitoringEvents') return Promise.resolve([]);
      if (key === 'saveSettings') return Promise.resolve({ success: true });
      return Promise.resolve(undefined);
    });
  });

  it('shows a loading indicator while fetching settings', () => {
    // invoke never resolves during this synchronous check
    mockInvoke.mockReturnValue(new Promise(() => {}));
    render(<SettingsForm />);
    expect(screen.getByText(/loading settings/i)).toBeInTheDocument();
  });

  it('renders all five config fields after settings load', async () => {
    // Default beforeEach provides the correct invoke responses.
    render(<SettingsForm />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('@agent')).toBeInTheDocument();
    });

    // CI provider selector should be present
    expect(screen.getByTestId('select-ciType')).toBeInTheDocument();

    // Bitbucket Pipelines fields should be visible (default ciType)
    expect(screen.getByPlaceholderText(/leave blank/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('ai-agent-hub')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/custom: run-agent-session/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('main')).toBeInTheDocument();
  });

  it('shows Jenkins fields when ciType is JENKINS', async () => {
    const jenkinsConfig = {
      ...DEFAULT_CONFIG,
      ciType: 'JENKINS' as const,
      jenkinsUrl: 'https://jenkins.example.com',
      jenkinsJobPath: 'job/my-job',
    };
    mockInvoke.mockImplementation((key: string) => {
      if (key === 'getSettings') return Promise.resolve(jenkinsConfig);
      if (key === 'getMonitoringEvents') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    render(<SettingsForm />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('@agent')).toBeInTheDocument();
    });

    // Jenkins-specific fields should be visible
    expect(screen.getByPlaceholderText('https://jenkins.example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('job/my-folder/job/my-job')).toBeInTheDocument();

    // Bitbucket Pipelines fields should NOT be visible
    expect(screen.queryByPlaceholderText(/leave blank/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('ai-agent-hub')).not.toBeInTheDocument();
  });

  it('displays an error message when loading fails', async () => {
    mockGetContext.mockRejectedValue(new Error('Context error'));

    render(<SettingsForm />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });

  it('passes project UUID to the getSettings resolver', async () => {
    // Default beforeEach provides the correct invoke responses.
    render(<SettingsForm />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('getSettings', { projectUuid: '{proj-uuid-test}' });
    });
  });

  it('passes project UUID to the getMonitoringEvents resolver', async () => {
    render(<SettingsForm />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('getMonitoringEvents', { projectUuid: '{proj-uuid-test}' });
    });
  });

  it('shows success message after a successful save', async () => {
    let saveResolved = false;
    mockInvoke.mockImplementation((key: string) => {
      if (key === 'getSettings') return Promise.resolve(DEFAULT_CONFIG);
      if (key === 'getMonitoringEvents') return Promise.resolve([]);
      if (key === 'saveSettings') { saveResolved = true; return Promise.resolve({ success: true }); }
      return Promise.resolve(undefined);
    });

    const { container } = render(<SettingsForm />);

    await waitFor(() => screen.getByDisplayValue(DEFAULT_CONFIG.triggerKeyword));

    await act(async () => {
      const form = container.querySelector('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/saved successfully/i)).toBeInTheDocument();
    });
    expect(saveResolved).toBe(true);
  });

  it('passes project UUID to the saveSettings resolver', async () => {
    mockInvoke.mockImplementation((key: string) => {
      if (key === 'getSettings') return Promise.resolve(DEFAULT_CONFIG);
      if (key === 'getMonitoringEvents') return Promise.resolve([]);
      if (key === 'saveSettings') return Promise.resolve({ success: true });
      return Promise.resolve(undefined);
    });

    const { container } = render(<SettingsForm />);

    await waitFor(() => screen.getByDisplayValue(DEFAULT_CONFIG.triggerKeyword));

    await act(async () => {
      const form = container.querySelector('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await waitFor(() => {
      // The save invoke call should include projectUuid and config.
      const saveCall = mockInvoke.mock.calls.find(
        (call: unknown[]) => call[0] === 'saveSettings',
      );
      expect(saveCall).toBeDefined();
      expect(saveCall![1]).toHaveProperty('projectUuid', '{proj-uuid-test}');
      expect(saveCall![1]).toHaveProperty('config');
    });
  });

  it('shows an error message when saveSettings fails', async () => {
    mockInvoke.mockImplementation((key: string) => {
      if (key === 'getSettings') return Promise.resolve(DEFAULT_CONFIG);
      if (key === 'getMonitoringEvents') return Promise.resolve([]);
      if (key === 'saveSettings') return Promise.reject(new Error('Save failed'));
      return Promise.resolve(undefined);
    });

    const { container } = render(<SettingsForm />);

    await waitFor(() => screen.getByDisplayValue(DEFAULT_CONFIG.triggerKeyword));

    await act(async () => {
      const form = container.querySelector('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/failed to save settings/i)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Jenkins URL validation tests
  // ---------------------------------------------------------------------------

  it('shows invalid URL error when Jenkins URL is malformed', async () => {
    // Arrange: Jenkins config with an invalid URL.
    mockInvoke.mockImplementation((key: string) => {
      if (key === 'getSettings') return Promise.resolve({
        ...DEFAULT_CONFIG,
        ciType: 'JENKINS',
        jenkinsUrl: 'not-a-valid-url',
      });
      if (key === 'getMonitoringEvents') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    const { container } = render(<SettingsForm />);
    await waitFor(() => screen.getByPlaceholderText('@agent'));

    // Act: submit the form.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    // Assert: URL validation error shown; no save attempted.
    await waitFor(() => {
      expect(screen.getByText(/invalid jenkins url format/i)).toBeInTheDocument();
    });
    // Only getSettings and getMonitoringEvents should have been called (no saveSettings).
    const saveCalls = mockInvoke.mock.calls.filter(
      (call: unknown[]) => call[0] === 'saveSettings',
    );
    expect(saveCalls).toHaveLength(0);
  });

  it('saves Jenkins settings successfully when URL is valid', async () => {
    // Arrange: Jenkins config with a valid URL.
    mockInvoke.mockImplementation((key: string) => {
      if (key === 'getSettings') return Promise.resolve({
        ...DEFAULT_CONFIG,
        ciType: 'JENKINS',
        jenkinsUrl: 'https://jenkins.mycompany.com',
      });
      if (key === 'getMonitoringEvents') return Promise.resolve([]);
      if (key === 'saveSettings') return Promise.resolve({ success: true });
      return Promise.resolve(undefined);
    });

    const { container } = render(<SettingsForm />);
    await waitFor(() => screen.getByPlaceholderText('@agent'));

    // Act: submit the form.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    // Assert: success message shown; saveSettings was called.
    await waitFor(() => {
      expect(screen.getByText(/saved successfully/i)).toBeInTheDocument();
    });
    const saveCall = mockInvoke.mock.calls.find(
      (call: unknown[]) => call[0] === 'saveSettings',
    );
    expect(saveCall).toBeDefined();
  });

  it('saves Jenkins settings without validation when URL is empty', async () => {
    // Arrange: Jenkins selected but no URL entered yet.
    mockInvoke.mockImplementation((key: string) => {
      if (key === 'getSettings') return Promise.resolve({
        ...DEFAULT_CONFIG,
        ciType: 'JENKINS',
        jenkinsUrl: '',
      });
      if (key === 'getMonitoringEvents') return Promise.resolve([]);
      if (key === 'saveSettings') return Promise.resolve({ success: true });
      return Promise.resolve(undefined);
    });

    const { container } = render(<SettingsForm />);
    await waitFor(() => screen.getByPlaceholderText('@agent'));

    // Act: submit the form.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    // Assert: settings saved without URL validation blocking.
    await waitFor(() => expect(screen.getByText(/saved successfully/i)).toBeInTheDocument());
  });

  // ---------------------------------------------------------------------------
  // Monitoring section tests
  // ---------------------------------------------------------------------------

  it('renders the monitoring toggle', async () => {
    render(<SettingsForm />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('@agent')).toBeInTheDocument();
    });

    expect(screen.getByTestId('toggle-monitoringEnabled')).toBeInTheDocument();
  });

  it('shows monitoring table when monitoring is enabled and events exist', async () => {
    const events = [
      {
        timestamp: '2026-04-12T14:00:00.000Z',
        projectUuid: '{proj-uuid-test}',
        workspaceUuid: '{ws-uuid}',
        repoUuid: '{repo-uuid}',
        prId: 7,
        commentId: 42,
        status: 'SUCCESS',
        provider: 'BITBUCKET_PIPELINES',
        message: 'Pipeline triggered.',
      },
    ];

    mockInvoke.mockImplementation((key: string) => {
      if (key === 'getSettings') return Promise.resolve({ ...DEFAULT_CONFIG, monitoringEnabled: true });
      if (key === 'getMonitoringEvents') return Promise.resolve(events);
      return Promise.resolve(undefined);
    });

    render(<SettingsForm />);

    await waitFor(() => {
      expect(screen.getByTestId('monitoring-table')).toBeInTheDocument();
    });
  });

  it('shows empty-state message when monitoring is enabled but no events exist', async () => {
    mockInvoke.mockImplementation((key: string) => {
      if (key === 'getSettings') return Promise.resolve({ ...DEFAULT_CONFIG, monitoringEnabled: true });
      if (key === 'getMonitoringEvents') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    render(<SettingsForm />);

    await waitFor(() => {
      expect(screen.getByText(/no dispatch events have been recorded/i)).toBeInTheDocument();
    });
  });
});
