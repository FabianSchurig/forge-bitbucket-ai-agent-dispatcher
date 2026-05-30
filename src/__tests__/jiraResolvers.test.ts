import { handler } from '../jiraResolvers';
import { mockRequestBitbucket, mockRequestJira } from '../__mocks__/@forge/api';
import { DEFAULT_CONFIG } from '../types';

// ---------------------------------------------------------------------------
// Mock storage so getSettings returns a deterministic config without KVS.
// ---------------------------------------------------------------------------
jest.mock('../storage', () => ({
  __esModule: true,
  getSettings: jest.fn().mockResolvedValue({ ...jest.requireActual('../types').DEFAULT_CONFIG }),
}));

/** Builds a fetch-style Response stub. */
function res(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Invokes a resolver definition by key. */
function invoke(key: string, payload: unknown): Promise<unknown> {
  const run = handler as unknown as (req: {
    key: string;
    payload: unknown;
  }) => Promise<unknown>;
  return run({ key, payload });
}

beforeEach(() => {
  mockRequestBitbucket.mockReset();
  mockRequestJira.mockReset();
});

describe('getJiraContext', () => {
  it('returns the issue key and a suggested branch name without calling Jira', async () => {
    const result = (await invoke('getJiraContext', { issueKey: 'PROJ-7' })) as {
      issueKey: string;
      suggestedBranch: string;
    };

    expect(result.issueKey).toBe('PROJ-7');
    expect(result.suggestedBranch).toBe('PROJ-7');
    // This app holds no Jira scopes: the resolver must never call requestJira.
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  it('throws when no issueKey is supplied', async () => {
    await expect(invoke('getJiraContext', {})).rejects.toThrow();
  });
});

describe('fetchRepositories', () => {
  it('maps the Bitbucket repositories response to a flat list', async () => {
    mockRequestBitbucket.mockResolvedValueOnce(
      res({
        values: [
          { slug: 'repo-a', full_name: 'ws/repo-a', workspace: { slug: 'ws' } },
          { slug: 'repo-b', full_name: 'ws2/repo-b', workspace: { slug: 'ws2' } },
        ],
      }),
    );

    const repos = (await invoke('fetchRepositories', {})) as Array<{
      workspace: string;
      repoSlug: string;
      fullName: string;
    }>;

    expect(repos).toEqual([
      { workspace: 'ws', repoSlug: 'repo-a', fullName: 'ws/repo-a' },
      { workspace: 'ws2', repoSlug: 'repo-b', fullName: 'ws2/repo-b' },
    ]);
  });

  it('throws a helpful error when the Bitbucket call fails', async () => {
    mockRequestBitbucket.mockResolvedValueOnce(res('nope', false, 403));
    await expect(invoke('fetchRepositories', {})).rejects.toThrow();
  });
});

describe('dispatchAgent', () => {
  const payload = {
    workspace: 'my-ws',
    repoSlug: 'my-repo',
    issueKey: 'PROJ-7',
    issueSummary: 'Fix the login bug',
  };

  it('creates the branch then triggers the pipeline and returns its id', async () => {
    // 1. repo details (for the base branch)
    mockRequestBitbucket.mockResolvedValueOnce(
      res({ mainbranch: { name: 'main' } }),
    );
    // 2. create branch
    mockRequestBitbucket.mockResolvedValueOnce(res({ name: 'PROJ-7-fix-the-login-bug' }, true, 201));
    // 3. trigger pipeline
    mockRequestBitbucket.mockResolvedValueOnce(
      res({ uuid: '{abc}', build_number: 42 }),
    );

    const result = (await invoke('dispatchAgent', payload)) as {
      success: boolean;
      branch: string;
      pipelineId?: string;
      buildUrl?: string;
    };

    expect(result.success).toBe(true);
    expect(result.branch).toBe('PROJ-7-fix-the-login-bug');
    expect(result.pipelineId).toBe('{abc}');
    expect(result.buildUrl).toContain('my-ws/my-repo/pipelines/results/42');

    // Branch creation must POST to the refs/branches endpoint.
    const branchCall = mockRequestBitbucket.mock.calls[1];
    expect(String(branchCall[0])).toContain('/refs/branches');
    expect(branchCall[1].method).toBe('POST');

    // Pipeline trigger must POST YAML to the pipelines endpoint.
    const pipelineCall = mockRequestBitbucket.mock.calls[2];
    expect(String(pipelineCall[0])).toContain('/pipelines');
    expect(pipelineCall[1].headers['Content-Type']).toBe('application/yaml');
  });

  it('tolerates an already-existing branch (idempotent) and still triggers', async () => {
    mockRequestBitbucket.mockResolvedValueOnce(res({ mainbranch: { name: 'main' } }));
    // Branch already exists → Bitbucket returns 409.
    mockRequestBitbucket.mockResolvedValueOnce(res({ error: 'exists' }, false, 409));
    mockRequestBitbucket.mockResolvedValueOnce(res({ uuid: '{x}', build_number: 7 }));

    const result = (await invoke('dispatchAgent', payload)) as { success: boolean };
    expect(result.success).toBe(true);
    expect(mockRequestBitbucket).toHaveBeenCalledTimes(3);
  });

  it('returns a failure result (does not throw) when the pipeline trigger fails', async () => {
    mockRequestBitbucket.mockResolvedValueOnce(res({ mainbranch: { name: 'main' } }));
    mockRequestBitbucket.mockResolvedValueOnce(res({}, true, 201));
    mockRequestBitbucket.mockResolvedValueOnce(res('boom', false, 500));

    const result = (await invoke('dispatchAgent', payload)) as {
      success: boolean;
      message: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/pipeline/i);
  });

  it('rejects an unsafe workspace slug before making any call', async () => {
    const result = (await invoke('dispatchAgent', {
      ...payload,
      workspace: 'bad/slug',
    })) as { success: boolean };
    expect(result.success).toBe(false);
    expect(mockRequestBitbucket).not.toHaveBeenCalled();
  });
});

// Keep DEFAULT_CONFIG import referenced so the lint rule does not flag it.
void DEFAULT_CONFIG;
