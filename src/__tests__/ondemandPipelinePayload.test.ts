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
    expect(queryString).toContain('target.type=pipeline_ref_target');
    expect(queryString).toContain('target.ref_type=branch');
    expect(queryString).not.toContain('target.selector.type=default');
  });

  it('emits all six pipeline variables using indexed variable notation', () => {
    const { queryParams } = buildOndemandRequest(makeContext(), makeConfig());
    const queryString = queryParams.toString();
    expect(queryString).toContain('variables%5B0%5D.key=SOURCE_WORKSPACE');
    expect(queryString).toContain('variables%5B0%5D.value=my-workspace');
    expect(queryString).toContain('variables%5B1%5D.key=SOURCE_REPO');
    expect(queryString).toContain('variables%5B1%5D.value=spoke-repo');
    expect(queryString).toContain('variables%5B2%5D.key=PR_ID');
    expect(queryString).toContain('variables%5B2%5D.value=7');
    expect(queryString).toContain('variables%5B3%5D.key=SOURCE_BRANCH');
    expect(queryString).toContain('variables%5B3%5D.value=feature%2Fcool-stuff');
    expect(queryString).toContain('variables%5B4%5D.key=COMMENT_TEXT');
    expect(queryString).toContain('variables%5B5%5D.key=COMMENT_AUTHOR');
    expect(queryString).toContain('variables%5B5%5D.value=user-123');
    // commentText with spaces is encoded as '+' or '%20' by URLSearchParams.
    // URLSearchParams in Node uses '+' for spaces.
    expect(queryString).toContain('variables%5B4%5D.value=%40agent+please+help');
  });

  it('safely encodes Unicode characters in variable values', () => {
    const { queryParams } = buildOndemandRequest(
      makeContext({ commentText: 'héllo 🚀' }),
      makeConfig(),
    );
    // encoded form of "héllo 🚀": %C3%A9 for 'é', '+' for space, %F0%9F%9A%80 for 🚀
    expect(queryParams.toString()).toContain('variables%5B4%5D.value=h%C3%A9llo+%F0%9F%9A%80');
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

  // -- Custom admin-defined pipeline variables ----------------------------

  it('appends custom variables after the 6 built-ins (indexes start at 6)', () => {
    const { queryParams } = buildOndemandRequest(
      makeContext(),
      makeConfig({
        pipelineVariables: [
          { key: 'GITHUB_TOKEN', value: 'ghp_abc', secured: true },
          { key: 'REGION', value: 'eu-west-1', secured: false },
        ],
      }),
    );
    const qs = queryParams.toString();
    expect(qs).toContain('variables%5B6%5D.key=GITHUB_TOKEN');
    expect(qs).toContain('variables%5B6%5D.value=ghp_abc');
    expect(qs).toContain('variables%5B6%5D.secured=true');
    expect(qs).toContain('variables%5B7%5D.key=REGION');
    expect(qs).toContain('variables%5B7%5D.value=eu-west-1');
    // secured=false must not be emitted at all.
    expect(qs).not.toContain('variables%5B7%5D.secured');
  });

  it('skips rows with an empty key without shifting indexes for the remainder', () => {
    const { queryParams } = buildOndemandRequest(
      makeContext(),
      makeConfig({
        pipelineVariables: [
          { key: '', value: 'orphan', secured: false },
          { key: 'KEEP_ME', value: 'yes', secured: false },
        ],
      }),
    );
    const qs = queryParams.toString();
    expect(qs).not.toContain('orphan');
    expect(qs).toContain('variables%5B6%5D.key=KEEP_ME');
  });

  it('throws CIProviderError for an invalid variable key', () => {
    expect(() =>
      buildOndemandRequest(
        makeContext(),
        makeConfig({
          pipelineVariables: [{ key: '1BAD-KEY', value: 'x', secured: false }],
        }),
      ),
    ).toThrow(CIProviderError);
  });
});
