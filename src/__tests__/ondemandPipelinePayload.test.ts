import { buildOndemandRequest } from '../ondemandPipelinePayload';
import { CIProviderError } from '../interfaces/CIProviderError';
import { DEFAULT_CONFIG } from '../types';
import type { AppConfig, DispatchContext } from '../types';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULT_CONFIG, ciType: 'BITBUCKET_ONDEMAND', ...overrides };
}

function makeContext(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    workspaceUuid: '{ws-uuid}',
    repoUuid: '{repo-uuid}',
    projectUuid: '{proj-uuid}',
    workspace: 'my-workspace',
    repoSlug: 'spoke-repo',
    prId: 7,
    sourceBranch: 'feature/cool-stuff',
    commentText: '@agent please help',
    commentAuthor: 'user-123',
    commentId: 42,
    ...overrides,
  };
}

describe('buildOndemandRequest', () => {
  // -- Target resolution ---------------------------------------------------

  it('falls back to spoke workspace/repo when ondemandTargetRepo is blank', () => {
    const result = buildOndemandRequest(makeContext(), makeConfig());
    expect(result.targetWorkspace).toBe('my-workspace');
    expect(result.targetRepoSlug).toBe('spoke-repo');
  });

  it('uses ondemandTargetRepo override when set', () => {
    const result = buildOndemandRequest(
      makeContext(),
      makeConfig({ ondemandTargetRepo: 'central-ws/agent-runner' }),
    );
    expect(result.targetWorkspace).toBe('central-ws');
    expect(result.targetRepoSlug).toBe('agent-runner');
  });

  it('throws CIProviderError when ondemandTargetRepo is malformed', () => {
    expect(() =>
      buildOndemandRequest(
        makeContext(),
        makeConfig({ ondemandTargetRepo: 'no-slash-here' }),
      ),
    ).toThrow(CIProviderError);
  });

  it('throws CIProviderError when ondemandTargetRepo contains invalid characters', () => {
    expect(() =>
      buildOndemandRequest(
        makeContext(),
        makeConfig({ ondemandTargetRepo: 'ws/repo?bad=1' }),
      ),
    ).toThrow(CIProviderError);
  });

  // -- Branch resolution ---------------------------------------------------

  it('falls back to PR source branch when ondemandTargetBranch is blank', () => {
    const result = buildOndemandRequest(makeContext(), makeConfig());
    expect(result.targetBranch).toBe('feature/cool-stuff');
    expect(result.queryParams.toString()).toContain('target.ref_name=feature%2Fcool-stuff');
  });

  it('uses ondemandTargetBranch override when set', () => {
    const result = buildOndemandRequest(
      makeContext(),
      makeConfig({ ondemandTargetBranch: 'release/v1' }),
    );
    expect(result.targetBranch).toBe('release/v1');
  });

  it('throws CIProviderError on a branch containing unsafe characters', () => {
    expect(() =>
      buildOndemandRequest(
        makeContext({ sourceBranch: 'evil?branch&injected=1' }),
        makeConfig(),
      ),
    ).toThrow(CIProviderError);
  });

  it('throws CIProviderError on an empty branch', () => {
    expect(() =>
      buildOndemandRequest(
        makeContext({ sourceBranch: '' }),
        makeConfig(),
      ),
    ).toThrow(CIProviderError);
  });

  // -- Query string format -------------------------------------------------

  it('includes the standard target.* parameters', () => {
    const { queryParams } = buildOndemandRequest(makeContext(), makeConfig());
    const queryString = queryParams.toString();
    expect(queryString).toContain('target.ref_type=branch');
    expect(queryString).toContain('target.selector.type=default');
  });

  it('emits all six pipeline variables using "variables.<KEY>=<value>" notation', () => {
    const { queryParams } = buildOndemandRequest(makeContext(), makeConfig());
    const queryString = queryParams.toString();
    expect(queryString).toContain('variables.SOURCE_WORKSPACE=my-workspace');
    expect(queryString).toContain('variables.SOURCE_REPO=spoke-repo');
    expect(queryString).toContain('variables.PR_ID=7');
    expect(queryString).toContain('variables.SOURCE_BRANCH=feature%2Fcool-stuff');
    expect(queryString).toContain('variables.COMMENT_AUTHOR=user-123');
    // commentText with spaces is encoded as '+' or '%20' by URLSearchParams.
    // URLSearchParams in Node uses '+' for spaces.
    expect(queryString).toContain('variables.COMMENT_TEXT=%40agent+please+help');
  });

  it('safely encodes Unicode characters in variable values', () => {
    const { queryParams } = buildOndemandRequest(
      makeContext({ commentText: 'héllo 🚀' }),
      makeConfig(),
    );
    // encoded form of "héllo 🚀": %C3%A9 for 'é', '+' for space, %F0%9F%9A%80 for 🚀
    expect(queryParams.toString()).toContain('variables.COMMENT_TEXT=h%C3%A9llo+%F0%9F%9A%80');
  });

  // -- YAML body -----------------------------------------------------------

  it('passes the YAML template through verbatim as yamlBody', () => {
    const customYaml =
      'pipelines:\n  default:\n    - step:\n        script:\n          - echo "$PR_ID"\n';
    const result = buildOndemandRequest(
      makeContext(),
      makeConfig({ ondemandYamlTemplate: customYaml }),
    );
    expect(result.yamlBody).toBe(customYaml);
  });
});
