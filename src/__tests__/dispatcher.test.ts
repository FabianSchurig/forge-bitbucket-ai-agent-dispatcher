import {
  extractTriggerContext,
  buildPipelinePayload,
  fetchRepositoryDetails,
  fetchCommentContent,
  triggerPipeline,
  postFailureComment,
  runDispatcher,
} from '../dispatcher';
import { DEFAULT_CONFIG } from '../types';
import type { DispatchContext } from '../types';

// ---------------------------------------------------------------------------
// Mock @forge/kvs (used by storage.ts, which dispatcher.ts depends on)
// ---------------------------------------------------------------------------

jest.mock('@forge/kvs', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
  },
}));

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
// Helper: make a minimal valid Forge event payload
//
// The Forge `avi:bitbucket:created:pullrequest-comment` event provides
// UUIDs for workspace/repository, an ID-only comment, and basic PR info
// (id, state, source/destination branches).  It does NOT include slugs
// or comment content.
// ---------------------------------------------------------------------------

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    comment: { id: 42 },
    pullrequest: {
      id: 7,
      state: 'OPEN',
      source: {
        branch: 'feature/cool-stuff',
        commit: { hash: 'abc123' },
      },
      destination: {
        branch: 'main',
        commit: { hash: 'def456' },
      },
    },
    repository: { uuid: '{repo-uuid-1234}' },
    workspace: { uuid: '{ws-uuid-5678}' },
    actor: { type: 'user', accountId: 'user-123', uuid: '{actor-uuid}' },
    ...overrides,
  };
}

// Helper: make a full DispatchContext for unit tests that don't go through
// extractTriggerContext.
function makeContext(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    workspaceUuid: '{ws-uuid-5678}',
    repoUuid: '{repo-uuid-1234}',
    workspace: 'my-workspace',
    repoSlug: 'spoke-repo',
    prId: 7,
    sourceBranch: 'feature/cool-stuff',
    commentText: '@agent do something',
    commentAuthor: 'user-123',
    commentId: 42,
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
    expect(ctx?.workspaceUuid).toBe('{ws-uuid-5678}');
    expect(ctx?.repoUuid).toBe('{repo-uuid-1234}');
    expect(ctx?.prId).toBe(7);
    expect(ctx?.commentId).toBe(42);
    expect(ctx?.commentAuthor).toBe('user-123');
    expect(ctx?.sourceBranch).toBe('feature/cool-stuff');
    // Slugs and comment text are empty until fetched via API.
    expect(ctx?.workspace).toBe('');
    expect(ctx?.repoSlug).toBe('');
    expect(ctx?.commentText).toBe('');
  });

  it('returns null when workspace UUID is missing', () => {
    const event = makeEvent({ workspace: {} });
    expect(extractTriggerContext(event)).toBeNull();
  });

  it('returns null when repository UUID is missing', () => {
    const event = makeEvent({ repository: {} });
    expect(extractTriggerContext(event)).toBeNull();
  });

  it('returns null when prId is missing', () => {
    const event = makeEvent({ pullrequest: { state: 'OPEN' } });
    expect(extractTriggerContext(event)).toBeNull();
  });

  it('returns null when commentId is missing', () => {
    const event = makeEvent({ comment: {} });
    expect(extractTriggerContext(event)).toBeNull();
  });

  it('falls back to actor uuid when accountId is absent', () => {
    const event = makeEvent({ actor: { type: 'user', uuid: '{fallback-uuid}' } });
    const ctx = extractTriggerContext(event);
    expect(ctx?.commentAuthor).toBe('{fallback-uuid}');
  });

  it('uses "unknown" when actor is absent', () => {
    const event = makeEvent({ actor: undefined });
    const ctx = extractTriggerContext(event);
    expect(ctx?.commentAuthor).toBe('unknown');
  });

  it('extracts source branch from pullrequest event data', () => {
    const event = makeEvent({
      pullrequest: {
        id: 3,
        state: 'OPEN',
        source: { branch: 'my-branch', commit: { hash: 'aaa' } },
        destination: { branch: 'main', commit: { hash: 'bbb' } },
      },
    });
    const ctx = extractTriggerContext(event);
    expect(ctx?.sourceBranch).toBe('my-branch');
  });
});

// ---------------------------------------------------------------------------
// buildPipelinePayload
// ---------------------------------------------------------------------------

describe('buildPipelinePayload', () => {
  const context = makeContext();

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
// fetchRepositoryDetails
// ---------------------------------------------------------------------------

describe('fetchRepositoryDetails', () => {
  beforeEach(() => mockRequestBitbucket.mockReset());

  it('returns workspace slug and repo slug on success', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: true,
      json: async () => ({
        slug: 'spoke-repo',
        workspace: { slug: 'my-workspace' },
      }),
      text: async () => '',
    });

    const result = await fetchRepositoryDetails('{ws-uuid}', '{repo-uuid}');
    expect(result.workspaceSlug).toBe('my-workspace');
    expect(result.repoSlug).toBe('spoke-repo');
  });

  it('throws on a non-OK response', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });

    await expect(fetchRepositoryDetails('{ws}', '{repo}')).rejects.toThrow(
      'Failed to fetch repository details: 404',
    );
  });
});

// ---------------------------------------------------------------------------
// fetchCommentContent
// ---------------------------------------------------------------------------

describe('fetchCommentContent', () => {
  beforeEach(() => mockRequestBitbucket.mockReset());

  it('returns the raw comment content on success', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: true,
      json: async () => ({ content: { raw: '@agent please review' } }),
      text: async () => '',
    });

    const text = await fetchCommentContent('{ws}', '{repo}', 7, 42);
    expect(text).toBe('@agent please review');
  });

  it('throws on a non-OK response', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });

    await expect(fetchCommentContent('{ws}', '{repo}', 7, 42)).rejects.toThrow(
      'Failed to fetch comment content: 404',
    );
  });

  it('returns empty string when content is missing', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => '',
    });

    const text = await fetchCommentContent('{ws}', '{repo}', 7, 42);
    expect(text).toBe('');
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

    const payload = buildPipelinePayload(makeContext(), DEFAULT_CONFIG);

    await expect(triggerPipeline('hub-ws', 'hub-repo', payload)).resolves.toBeUndefined();
    expect(mockRequestBitbucket).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-OK response', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    });

    const payload = buildPipelinePayload(makeContext(), DEFAULT_CONFIG);

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

    await expect(postFailureComment('{ws}', '{repo}', 1, 42)).resolves.toBeUndefined();
    expect(mockRequestBitbucket).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the API call fails', async () => {
    mockRequestBitbucket.mockResolvedValue({
      ok: false,
      text: async () => 'Forbidden',
    });

    await expect(postFailureComment('{ws}', '{repo}', 1, 42)).resolves.toBeUndefined();
  });

  it('does not throw when requestBitbucket itself rejects', async () => {
    mockRequestBitbucket.mockRejectedValue(new Error('Network error'));

    await expect(postFailureComment('{ws}', '{repo}', 1, 42)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runDispatcher (integration-style unit tests)
// ---------------------------------------------------------------------------

describe('runDispatcher', () => {
  beforeEach(() => {
    mockRequestBitbucket.mockReset();
    // Default: storage returns no stored config (uses defaults).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kvsMock = jest.requireMock('@forge/kvs') as any;
    (kvsMock.default.get as jest.Mock).mockResolvedValue(undefined);
  });

  it('returns early when the event payload is invalid', async () => {
    await runDispatcher({});
    expect(mockRequestBitbucket).not.toHaveBeenCalled();
  });

  it('returns early when the event is self-generated', async () => {
    await runDispatcher({ ...makeEvent(), selfGenerated: true });
    expect(mockRequestBitbucket).not.toHaveBeenCalled();
  });

  it('returns early when the trigger keyword is absent from the comment', async () => {
    // 1st call: fetchCommentContent – returns text without keyword
    mockRequestBitbucket.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: { raw: 'hello world' } }),
      text: async () => '',
    });

    await runDispatcher(makeEvent());
    // Only the comment-fetch call should have been made.
    expect(mockRequestBitbucket).toHaveBeenCalledTimes(1);
  });

  it('fetches comment, repo details, and triggers the pipeline when keyword is present', async () => {
    mockRequestBitbucket
      // 1st call: fetchCommentContent
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: { raw: '@agent please review' } }),
        text: async () => '',
      })
      // 2nd call: fetchRepositoryDetails
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slug: 'spoke-repo', workspace: { slug: 'my-workspace' } }),
        text: async () => '',
      })
      // 3rd call: triggerPipeline
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => '',
      });

    await runDispatcher(makeEvent());
    expect(mockRequestBitbucket).toHaveBeenCalledTimes(3);
  });

  it('posts a failure comment when triggerPipeline throws', async () => {
    mockRequestBitbucket
      // fetchCommentContent
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: { raw: '@agent please review' } }),
        text: async () => '',
      })
      // fetchRepositoryDetails
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slug: 'spoke-repo', workspace: { slug: 'my-workspace' } }),
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
    // All four Bitbucket calls should have been made.
    expect(mockRequestBitbucket).toHaveBeenCalledTimes(4);
  });

  it('uses the current workspace slug when hubWorkspace is blank', async () => {
    mockRequestBitbucket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: { raw: '@agent please review' } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slug: 'spoke-repo', workspace: { slug: 'my-workspace' } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({ ok: true, status: 201, text: async () => '' });

    await runDispatcher(makeEvent());

    // The 3rd call (triggerPipeline) should target my-workspace/ai-agent-hub.
    const triggerCallUrl = mockRequestBitbucket.mock.calls[2][0] as string;
    expect(triggerCallUrl).toContain('my-workspace');
    expect(triggerCallUrl).toContain('ai-agent-hub');
  });

  it('uses a custom hubWorkspace from stored config', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kvsMock = jest.requireMock('@forge/kvs') as any;
    (kvsMock.default.get as jest.Mock).mockResolvedValue({
      ...DEFAULT_CONFIG,
      hubWorkspace: 'central-workspace',
    });

    mockRequestBitbucket
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: { raw: '@agent please review' } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slug: 'spoke-repo', workspace: { slug: 'my-workspace' } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({ ok: true, status: 201, text: async () => '' });

    await runDispatcher(makeEvent());

    const triggerCallUrl = mockRequestBitbucket.mock.calls[2][0] as string;
    expect(triggerCallUrl).toContain('central-workspace');
  });
});
