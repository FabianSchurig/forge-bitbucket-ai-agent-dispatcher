import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { SettingsForm } from '../settings';
import { DEFAULT_CONFIG } from '../types';

// ---------------------------------------------------------------------------
// Mock @forge/bridge
// ---------------------------------------------------------------------------

jest.mock('@forge/bridge', () => ({
  invoke: jest.fn(),
}));

// Retrieve a stable reference after the mock factory has run.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bridgeMock = jest.requireMock('@forge/bridge') as any;
const mockInvoke: jest.Mock = bridgeMock.invoke;

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
    mockInvoke.mockRejectedValue(new Error('Network error'));

    render(<SettingsForm />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });

  it('calls invoke("getSettings") on mount', async () => {
    mockInvoke.mockResolvedValue(DEFAULT_CONFIG);

    render(<SettingsForm />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('getSettings');
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
});
