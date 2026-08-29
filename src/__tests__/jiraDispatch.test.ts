import { buildJiraDispatchRequest } from '../jira/jiraDispatch';
import { CIProviderError } from '../interfaces/CIProviderError';
import { DEFAULT_CONFIG } from '../types';
import type { AppConfig } from '../types';

/** Convenience: a fully-populated config with optional overrides. */
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

const baseInput = {
  workspace: 'my-workspace',
  repoSlug: 'my-repo',
  branch: 'PROJ-123-fix-login',
  issueKey: 'PROJ-123',
  issueSummary: 'Fix login bug',
};

describe('buildJiraDispatchRequest', () => {
  it('targets the supplied workspace/repo/branch', () => {
    const req = buildJiraDispatchRequest(baseInput, makeConfig());
    expect(req.targetWorkspace).toBe('my-workspace');
    expect(req.targetRepoSlug).toBe('my-repo');
    expect(req.targetBranch).toBe('PROJ-123-fix-login');
    expect(req.queryParams.get('target.type')).toBe('pipeline_ref_target');
    expect(req.queryParams.get('target.ref_type')).toBe('branch');
    expect(req.queryParams.get('target.ref_name')).toBe('PROJ-123-fix-login');
  });

  it('passes Jira metadata strictly as pipeline variables (not concatenated)', () => {
    const req = buildJiraDispatchRequest(baseInput, makeConfig());
    const keys = req.queryParams.getAll('variables[0].key').concat(
      req.queryParams.getAll('variables[1].key'),
      req.queryParams.getAll('variables[2].key'),
      req.queryParams.getAll('variables[3].key'),
      req.queryParams.getAll('variables[4].key'),
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        'SOURCE_WORKSPACE',
        'SOURCE_REPO',
        'SOURCE_BRANCH',
        'JIRA_ISSUE_KEY',
        'JIRA_ISSUE_SUMMARY',
      ]),
    );
  });

  it('URL-encodes a malicious summary so it cannot break out of the variable', () => {
    const req = buildJiraDispatchRequest(
      { ...baseInput, issueSummary: 'evil"; rm -rf / #' },
      makeConfig(),
    );
    // The raw summary is carried verbatim as a variable *value*; URLSearchParams
    // percent-encodes it, so it can never be interpreted as URL structure.
    const serialised = req.queryParams.toString();
    expect(serialised).not.toContain('rm -rf');
    expect(req.queryParams.getAll('variables[4].value')).toContain(
      'evil"; rm -rf / #',
    );
  });

  it('uses the configured on-demand YAML template as the request body', () => {
    const config = makeConfig({ ondemandYamlTemplate: 'pipelines:\n  default: []' });
    const req = buildJiraDispatchRequest(baseInput, config);
    expect(req.yamlBody).toBe('pipelines:\n  default: []');
  });

  it('appends admin-defined pipeline variables after the Jira variables', () => {
    const config = makeConfig({
      pipelineVariables: [{ key: 'CUSTOM_TOKEN', value: 'abc', secured: true }],
    });
    const req = buildJiraDispatchRequest(baseInput, config);
    expect(req.queryParams.get('variables[5].key')).toBe('CUSTOM_TOKEN');
    expect(req.queryParams.get('variables[5].value')).toBe('abc');
    expect(req.queryParams.get('variables[5].secured')).toBe('true');
  });

  it('rejects an unsafe workspace slug', () => {
    expect(() =>
      buildJiraDispatchRequest({ ...baseInput, workspace: 'bad/slug' }, makeConfig()),
    ).toThrow(CIProviderError);
  });

  it('rejects an unsafe branch name', () => {
    expect(() =>
      buildJiraDispatchRequest({ ...baseInput, branch: 'bad branch' }, makeConfig()),
    ).toThrow(CIProviderError);
  });
});
