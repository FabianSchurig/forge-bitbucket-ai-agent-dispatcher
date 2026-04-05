import {
  extractTriggerContext,
  buildPipelinePayload,
  fetchPRDetails,
  triggerPipeline,
  postFailureComment,
  runDispatcher,
} from '../dispatcher';
import { DEFAULT_CONFIG } from '../types';

// ---------------------------------------------------------------------------
// Mock @forge/api
// ---------------------------------------------------------------------------

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: {
    asApp: jest.fn().mockReturnValue({
      requestBitbucket: jest.fn(),
    }),
  },
  storage: {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
  },
  route: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? String(values[i]) : ''),
      '',
    ),
}));

// Retrieve stable references to the mock functions after the factory has run.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const forgeApiMock = jest.requireMock('@forge/api') as any;
// asApp() always returns the same object due to mockReturnValue.
const mockRequestBitbucket: jest.Mock = forgeApiMock.default.asApp().requestBitbucket;

// ---------------------------------------------------------------------------
// Helper: make a minimal valid event payload
// ---------------------------------------------------------------------------

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    comment: {
      id: 42,
      content: { raw: '@agent please review' },
    },
    pullrequest: { id: 7 },
    repository: {
      slug: 'spoke-repo',
      workspace: { slug: 'my-workspace' },
    },
    actor: { account_id: 'user-123', display_name: 'Alice' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractTriggerContext
// ---------------------------------------------------------------------------

describe('extractTriggerContext', () => {
  it('returns a populated DispatchContext for a valid event', () => {
    const ctx = extractTriggerContext(makeEvent());
    expect(ctx).not.toBeNull();
    expect(ctx?.workspace).toBe('my-workspace');
    expect(ctx?.repoSlug).toBe('spoke-repo');
    expect(ctx?.prId).toBe(7);
    expect(ctx?.commentId).toBe(42);
    expect(ctx?.commentText).toBe('@agent please review');
    expect(ctx?.commentAuthor).toBe('user-123');
    expect(ctx?.sourceBranch).toBe('');
  });

  it('returns null when workspace is missing', () => {
    const event = makeEvent({ repository: { slug: 'spoke-repo', workspace: {} } });
    expect(extractTriggerContext(event)).toBeNull();
  });

  it('returns null when repoSlug is missing', () => {
    const event = makeEvent({ repository: { workspace: { slug: 'my-workspace' } } });
    expect(extractTriggerContext(event)).toBeNull();
  });

  it('returns null when prId is missing', () => {
    const event = makeEvent({ pullrequest: {} });
    expect(extractTriggerContext(event)).toBeNull();
  });

  it('falls back to display_name when account_id is absent', () => {
    const event = makeEvent({ actor: { display_name: 'Bob' } });
    const ctx = extractTriggerContext(event);
    expect(ctx?.commentAuthor).toBe('Bob');
  });

  it('uses "unknown" when actor is absent', () => {
    const event = makeEvent({ actor: undefined });
    const ctx = extractTriggerContext(event);
    expect(ctx?.commentAuthor).toBe('unknown');
  });

  it('treats empty comment text as an empty string', () => {
    const event = makeEvent({ comment: { id: 1, content: { raw: '' } } });
    const ctx = extractTriggerContext(event);
    expect(ctx?.commentText).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildPipelinePayload
// ---------------------------------------------------------------------------

describe('buildPipelinePayload', () => {
  const context = {
    workspace: 'my-workspace',
    repoSlug: 'spoke-repo',
    prId: 7,
    sourceBranch: 'feature/cool-stuff',
    commentText: '@agent do something',
    commentAuthor: 'user-123',
    commentId: 42,
  };

  it('strips the "custom: " prefix from hubPipeline', () => {
    const payload = buildPipelinePayload(context, DEFAULT_CONFIG);
    expect(payload.target.selector.pattern).toBe('run-agent-session');
  });

  it('handles pipeline names without the "custom: " prefix', () => {
    const config = { ...DEFAULT_CONFIG, hubPipeline: 'my-pipeline' };
    const payload = buildPipelinePayload(context, config);
    expect(payload.target.selector.pattern).toBe('my-pipeline');
  });

  it('sets the correct branch ref', () => {
    const payload = buildPipelinePayload(context, DEFAULT_CONFIG);
    expect(payload.target.ref_name).toBe('main');
    expect(payload.target.ref_type).toBe('branch');
    expect(payload.target.type).toBe('pipeline_ref_target');
  });

  it('injects all six pipeline variables', () => {
    const payload = buildPipelinePayload(context, DEFAULT_CONFIG);
    const keys = payload.variables.map((v) => v.key);
    expect(keys).toEqual([
      'SOURCE_WORKSPACE',
      'SOURCE_REPO',
      'PR_ID',
      'SOURCE_BRANCH',
      'COMMENT_TEXT',
      'COMMENT_AUTHOR',
    ]);
  });

  it('serializes PR_ID as a string', () => {
    const payload = buildPipelinePayload(context, DEFAULT_CONFIG);
    const prIdVar = payload.variables.find((v) => v.key === 'PR_ID');
    expect(prIdVar?.value).toBe('7');
  });

  it('passes correct context values in variables', () => {
    const payload = buildPipelinePayload(context, DEFAULT_CONFIG);
    const byKey = Object.fromEntries(payload.variables.map((v) => [v.key, v.value]));
    expect(byKey['SOURCE_WORKSPACE']).toBe('my-workspace');
    expect(byKey['SOURCE_REPO']).toBe('spoke-repo');
    expect(byKey['SOURCE_BRANCH']).toBe('feature/cool-stuff');
    expect(byKey['COMMENT_TEXT']).toBe('@agent do something');
    expect(byKey['COMMENT_AUTHOR']).toBe('user-123');
  });
});

// ---------------------------------------------------------------------------
// fetchPRDetails
// ---------------------------------------------------------------------------

describe('fetchPRDetails', () => {
  beforeEach(() => mockRequestBitbucket.mockReset());

  it('returns sourceBranch on a successful response', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: true,
      json: async () => ({ source: { branch: { name: 'feature/abc' } } }),
      text: async () => '',
    });

    const result = await fetchPRDetails('ws', 'repo', 1);
    expect(result.sourceBranch).toBe('feature/abc');
  });

  it('throws on a non-OK response', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });

    await expect(fetchPRDetails('ws', 'repo', 99)).rejects.toThrow(
      'Failed to fetch PR details: 404',
    );
  });

  it('returns empty string when branch name is missing in payload', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => '',
    });

    const result = await fetchPRDetails('ws', 'repo', 1);
    expect(result.sourceBranch).toBe('');
  });
});

// ---------------------------------------------------------------------------
// triggerPipeline
// ---------------------------------------------------------------------------

describe('triggerPipeline', () => {
  beforeEach(() => mockRequestBitbucket.mockReset());

  it('resolves without error on a 201 response', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => '',
    });

    const payload = buildPipelinePayload(
      {
        workspace: 'ws',
        repoSlug: 'repo',
        prId: 1,
        sourceBranch: 'main',
        commentText: '@agent',
        commentAuthor: 'u',
        commentId: 1,
      },
      DEFAULT_CONFIG,
    );

    await expect(triggerPipeline('hub-ws', 'hub-repo', payload)).resolves.toBeUndefined();
    expect(mockRequestBitbucket).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-OK response', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    });

    const payload = buildPipelinePayload(
      {
        workspace: 'ws',
        repoSlug: 'repo',
        prId: 1,
        sourceBranch: 'main',
        commentText: '@agent',
        commentAuthor: 'u',
        commentId: 1,
      },
      DEFAULT_CONFIG,
    );

    await expect(triggerPipeline('hub-ws', 'hub-repo', payload)).rejects.toThrow(
      'Failed to trigger pipeline: 400',
    );
  });
});

// ---------------------------------------------------------------------------
// postFailureComment
// ---------------------------------------------------------------------------

describe('postFailureComment', () => {
  beforeEach(() => mockRequestBitbucket.mockReset());

  it('posts a comment and does not throw on success', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: true,
      text: async () => '',
    });

    await expect(postFailureComment('ws', 'repo', 1, 42)).resolves.toBeUndefined();
    expect(mockRequestBitbucket).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the API call fails', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: false,
      text: async () => 'Forbidden',
    });

    await expect(postFailureComment('ws', 'repo', 1, 42)).resolves.toBeUndefined();
  });

  it('does not throw when requestBitbucket itself rejects', async () => {
    mockRequestBitbucket.mockRejectedValue(new Error('Network error'));

    await expect(postFailureComment('ws', 'repo', 1, 42)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runDispatcher (integration-style unit tests)
// ---------------------------------------------------------------------------

describe('runDispatcher', () => {
  beforeEach(() => {
    mockRequestBitbucket.mockReset();
    // Default: storage returns no stored config (uses defaults).
    const { storage } = jest.requireMock('@forge/api');
    (storage.get as jest.Mock).mockResolvedValue(undefined);
  });

  it('returns early when the event payload is invalid', async () => {
    await runDispatcher({});
    expect(mockRequestBitbucket).not.toHaveBeenCalled();
  });

  it('returns early when the trigger keyword is absent', async () => {
    const event = makeEvent({ comment: { id: 1, content: { raw: 'hello world' } } });
    await runDispatcher(event);
    expect(mockRequestBitbucket).not.toHaveBeenCalled();
  });

  it('fetches PR details and triggers the pipeline when keyword is present', async () => {
    // First call: fetchPRDetails
    mockRequestBitbucket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ source: { branch: { name: 'feat/x' } } }),
        text: async () => '',
      })
      // Second call: triggerPipeline
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => '',
      });

    await runDispatcher(makeEvent());
    expect(mockRequestBitbucket).toHaveBeenCalledTimes(2);
  });

  it('posts a failure comment when triggerPipeline throws', async () => {
    // fetchPRDetails succeeds
    mockRequestBitbucket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ source: { branch: { name: 'feat/x' } } }),
        text: async () => '',
      })
      // triggerPipeline fails
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })
      // postFailureComment succeeds
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      });

    await runDispatcher(makeEvent());
    // All three Bitbucket calls should have been made.
    expect(mockRequestBitbucket).toHaveBeenCalledTimes(3);
  });

  it('uses the current workspace when hubWorkspace is blank', async () => {
    mockRequestBitbucket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ source: { branch: { name: 'feat/x' } } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({ ok: true, status: 201, text: async () => '' });

    await runDispatcher(makeEvent());

    // The second call should target my-workspace/ai-agent-hub (the default config).
    const secondCallUrl = mockRequestBitbucket.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain('my-workspace');
    expect(secondCallUrl).toContain('ai-agent-hub');
  });

  it('uses a custom hubWorkspace from stored config', async () => {
    const { storage } = jest.requireMock('@forge/api');
    (storage.get as jest.Mock).mockResolvedValue({
      ...DEFAULT_CONFIG,
      hubWorkspace: 'central-workspace',
    });

    mockRequestBitbucket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ source: { branch: { name: 'feat/x' } } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({ ok: true, status: 201, text: async () => '' });

    await runDispatcher(makeEvent());

    const secondCallUrl = mockRequestBitbucket.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain('central-workspace');
  });
});
