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
  // permissions.egress.set is the Customer-Managed Egress API used when saving
  // Jenkins settings. It triggers the Atlassian admin consent modal.
  permissions: {
    egress: {
      set: jest.fn(),
    },
  },
}));

// Retrieve stable references after the mock factory has run.
// Using jest.requireMock() avoids hoisting issues with outer `let` variables.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bridgeMock = jest.requireMock('@forge/bridge') as any;
const mockInvoke: jest.Mock = bridgeMock.invoke;
const mockGetContext: jest.Mock = bridgeMock.view.getContext;
const mockPermissionsEgressSet: jest.Mock = bridgeMock.permissions.egress.set;

// ---------------------------------------------------------------------------
// Mock @forge/egress
// ---------------------------------------------------------------------------
// EgressType is imported by settings.tsx to specify the egress direction.
// FetchBackendSide means Forge's server-side proxy makes the outbound request.
jest.mock('@forge/egress', () => ({
  __esModule: true,
  EgressType: {
    FetchBackendSide: 'FETCH_BACKEND_SIDE',
    FetchClientSide: 'FETCH_CLIENT_SIDE',
  },
}));

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
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsForm', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockGetContext.mockReset();
    mockPermissionsEgressSet.mockReset();
    // Default: view.getContext resolves with a project context.
    mockGetContext.mockResolvedValue({
      extension: {
        project: { uuid: '{proj-uuid-test}' },
      },
    });
    // Default: egress permission is granted (resolves successfully).
    mockPermissionsEgressSet.mockResolvedValue({ results: [] });
  });

  it('shows a loading indicator while fetching settings', () => {
    // invoke never resolves during this synchronous check
    mockInvoke.mockReturnValue(new Promise(() => {}));
    render(<SettingsForm />);
    expect(screen.getByText(/loading settings/i)).toBeInTheDocument();
  });

  it('renders all five config fields after settings load', async () => {
    mockInvoke.mockResolvedValue(DEFAULT_CONFIG);

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
    mockInvoke.mockResolvedValue({
      ...DEFAULT_CONFIG,
      ciType: 'JENKINS',
      jenkinsUrl: 'https://jenkins.example.com',
      jenkinsJobPath: 'job/my-job',
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
    mockInvoke.mockResolvedValue(DEFAULT_CONFIG);

    render(<SettingsForm />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('getSettings', { projectUuid: '{proj-uuid-test}' });
    });
  });

  it('shows success message after a successful save', async () => {
    mockInvoke
      .mockResolvedValueOnce(DEFAULT_CONFIG) // getSettings
      .mockResolvedValueOnce({ success: true }); // saveSettings

    const { container } = render(<SettingsForm />);

    await waitFor(() => screen.getByDisplayValue(DEFAULT_CONFIG.triggerKeyword));

    await act(async () => {
      const form = container.querySelector('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/saved successfully/i)).toBeInTheDocument();
    });
  });

  it('passes project UUID to the saveSettings resolver', async () => {
    mockInvoke
      .mockResolvedValueOnce(DEFAULT_CONFIG) // getSettings
      .mockResolvedValueOnce({ success: true }); // saveSettings

    const { container } = render(<SettingsForm />);

    await waitFor(() => screen.getByDisplayValue(DEFAULT_CONFIG.triggerKeyword));

    await act(async () => {
      const form = container.querySelector('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await waitFor(() => {
      // The second invoke call should include projectUuid and config.
      const saveCall = mockInvoke.mock.calls.find(
        (call: unknown[]) => call[0] === 'saveSettings',
      );
      expect(saveCall).toBeDefined();
      expect(saveCall![1]).toHaveProperty('projectUuid', '{proj-uuid-test}');
      expect(saveCall![1]).toHaveProperty('config');
    });
  });

  it('shows an error message when saveSettings fails', async () => {
    mockInvoke
      .mockResolvedValueOnce(DEFAULT_CONFIG) // getSettings
      .mockRejectedValueOnce(new Error('Save failed')); // saveSettings

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
  // Customer-Managed Egress tests
  // ---------------------------------------------------------------------------

  it('requests egress permission for the Jenkins hostname when saving Jenkins config', async () => {
    // Arrange: load settings with Jenkins URL configured.
    mockInvoke
      .mockResolvedValueOnce({
        ...DEFAULT_CONFIG,
        ciType: 'JENKINS',
        jenkinsUrl: 'https://jenkins.example.com',
      }) // getSettings
      .mockResolvedValueOnce({ success: true }); // saveSettings

    const { container } = render(<SettingsForm />);
    await waitFor(() => screen.getByPlaceholderText('@agent'));

    // Act: submit the form.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    // Assert: egress.set was called with the Jenkins hostname.
    await waitFor(() => {
      expect(mockPermissionsEgressSet).toHaveBeenCalledWith(
        expect.objectContaining({
          egresses: expect.arrayContaining([
            expect.objectContaining({
              key: 'jenkins-instance',
              configured: expect.arrayContaining([
                expect.objectContaining({
                  domain: 'jenkins.example.com',
                  type: expect.arrayContaining(['FETCH_BACKEND_SIDE']),
                }),
              ]),
            }),
          ]),
        }),
      );
    });
  });

  it('does not request egress permission when ciType is BITBUCKET_PIPELINES', async () => {
    // Arrange: default config uses BITBUCKET_PIPELINES.
    mockInvoke
      .mockResolvedValueOnce(DEFAULT_CONFIG) // getSettings
      .mockResolvedValueOnce({ success: true }); // saveSettings

    const { container } = render(<SettingsForm />);
    await waitFor(() => screen.getByDisplayValue(DEFAULT_CONFIG.triggerKeyword));

    // Act: submit the form.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    await waitFor(() => expect(screen.getByText(/saved successfully/i)).toBeInTheDocument());

    // Assert: no egress call for Bitbucket Pipelines provider.
    expect(mockPermissionsEgressSet).not.toHaveBeenCalled();
  });

  it('does not request egress permission when ciType is JENKINS but URL is empty', async () => {
    // Arrange: Jenkins selected but no URL entered yet.
    mockInvoke
      .mockResolvedValueOnce({
        ...DEFAULT_CONFIG,
        ciType: 'JENKINS',
        jenkinsUrl: '',
      }) // getSettings
      .mockResolvedValueOnce({ success: true }); // saveSettings

    const { container } = render(<SettingsForm />);
    await waitFor(() => screen.getByPlaceholderText('@agent'));

    // Act: submit the form.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    await waitFor(() => expect(screen.getByText(/saved successfully/i)).toBeInTheDocument());

    // Assert: no egress call when URL is empty.
    expect(mockPermissionsEgressSet).not.toHaveBeenCalled();
  });

  it('shows egress error message when egress permission is denied by the admin', async () => {
    // Arrange: Jenkins config with a URL, but egress approval is rejected.
    mockInvoke.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      ciType: 'JENKINS',
      jenkinsUrl: 'https://jenkins.example.com',
    }); // getSettings
    mockPermissionsEgressSet.mockRejectedValueOnce(new Error('Permission denied by user'));

    const { container } = render(<SettingsForm />);
    await waitFor(() => screen.getByPlaceholderText('@agent'));

    // Act: submit the form.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    // Assert: egress-specific error shown; saveSettings never called.
    await waitFor(() => {
      // Check for text unique to the error message (not the info section message).
      expect(screen.getByText(/Jenkins URL approval failed/i)).toBeInTheDocument();
    });
    // saveSettings must not be called after a denied egress request.
    expect(mockInvoke).toHaveBeenCalledTimes(1); // only getSettings
  });

  it('shows invalid URL error when Jenkins URL is malformed', async () => {
    // Arrange: Jenkins config with an invalid URL.
    mockInvoke.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      ciType: 'JENKINS',
      jenkinsUrl: 'not-a-valid-url',
    }); // getSettings

    const { container } = render(<SettingsForm />);
    await waitFor(() => screen.getByPlaceholderText('@agent'));

    // Act: submit the form.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    // Assert: URL validation error shown; no egress call or save attempted.
    await waitFor(() => {
      expect(screen.getByText(/invalid jenkins url format/i)).toBeInTheDocument();
    });
    expect(mockPermissionsEgressSet).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledTimes(1); // only getSettings
  });

  it('saves settings successfully after egress permission is granted', async () => {
    // Arrange: Jenkins config; egress approved; save succeeds.
    mockInvoke
      .mockResolvedValueOnce({
        ...DEFAULT_CONFIG,
        ciType: 'JENKINS',
        jenkinsUrl: 'https://jenkins.mycompany.com',
      }) // getSettings
      .mockResolvedValueOnce({ success: true }); // saveSettings
    mockPermissionsEgressSet.mockResolvedValueOnce({ results: [] });

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
});
