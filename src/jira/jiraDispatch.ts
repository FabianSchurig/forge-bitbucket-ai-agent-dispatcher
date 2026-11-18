/**
 * Builds the Bitbucket on-demand pipelines request for the Jira issue-context
 * dispatcher.
 *
 * This mirrors {@link buildOndemandRequest} (the PR-comment flow) but carries
 * Jira metadata instead of PR/comment metadata.  It deliberately reuses the
 * exported slug/branch validators and the {@link appendPipelineVariables}
 * helper so the security-relevant rules ("what is a safe slug/branch", "how are
 * admin variables encoded") live in exactly one place and cannot drift between
 * the two dispatch flows.
 *
 * Security note: every piece of user-controlled Jira metadata (issue key,
 * summary) is passed as a pipeline *variable value*.  URLSearchParams
 * percent-encodes those values, and Bitbucket exposes them to the runner as
 * ordinary environment variables.  Nothing is concatenated into shell commands
 * or into the URL structure, which is what neutralises prompt/command-injection
 * via a crafted issue summary.
 */

import type { AppConfig } from '../types';
import {
  appendPipelineVariables,
  validateBranch,
  validateSlug,
} from '../ondemandPipelinePayload';

/** Provider label used in validation error messages. */
const PROVIDER_NAME = 'Jira AI Agent Dispatch';

/** Inputs required to dispatch an agent run from a Jira issue. */
export interface JiraDispatchInput {
  /** Bitbucket workspace slug of the target repository. */
  workspace: string;
  /** Repository slug of the target repository. */
  repoSlug: string;
  /** Branch the pipeline runs against (already slugified + safe). */
  branch: string;
  /** Jira issue key (e.g. "PROJ-123"). */
  issueKey: string;
  /** Jira issue summary (free-form, user-controlled). */
  issueSummary: string;
}

/** The pieces needed to issue the on-demand pipelines API call. */
export interface JiraDispatchRequest {
  /** Workspace slug used to construct the API path. */
  targetWorkspace: string;
  /** Repository slug used to construct the API path. */
  targetRepoSlug: string;
  /** Validated branch name used for `target.ref_name`. */
  targetBranch: string;
  /** YAML body to POST (Content-Type: application/yaml). */
  yamlBody: string;
  /** Query string carrying target selection + variables. */
  queryParams: URLSearchParams;
}

/**
 * Builds + validates the on-demand pipelines request for a Jira dispatch.
 * Throws CIProviderError (via the shared validators) on any unsafe slug or
 * branch value before any network call is made.
 */
export function buildJiraDispatchRequest(
  input: JiraDispatchInput,
  config: AppConfig,
): JiraDispatchRequest {
  validateSlug(input.workspace, 'workspace slug', PROVIDER_NAME);
  validateSlug(input.repoSlug, 'repository slug', PROVIDER_NAME);
  validateBranch(input.branch, PROVIDER_NAME);

  const params = new URLSearchParams();
  params.append('target.type', 'pipeline_ref_target');
  params.append('target.ref_type', 'branch');
  params.append('target.ref_name', input.branch);

  // The Jira metadata becomes environment variables inside the runner. The
  // runner's bitbucket-pipelines.yml reads $JIRA_ISSUE_KEY / $JIRA_ISSUE_SUMMARY
  // (see README "Runner contract").
  const variables: Array<[string, string]> = [
    ['SOURCE_WORKSPACE', input.workspace],
    ['SOURCE_REPO', input.repoSlug],
    ['SOURCE_BRANCH', input.branch],
    ['JIRA_ISSUE_KEY', input.issueKey],
    ['JIRA_ISSUE_SUMMARY', input.issueSummary],
  ];

  variables.forEach(([key, value], index) => {
    params.append(`variables[${index}].key`, key);
    params.append(`variables[${index}].value`, value);
  });

  // Continue the indexed sequence with the admin-defined extra variables.
  appendPipelineVariables(params, variables.length, config.pipelineVariables);

  return {
    targetWorkspace: input.workspace,
    targetRepoSlug: input.repoSlug,
    targetBranch: input.branch,
    yamlBody: config.ondemandYamlTemplate,
    queryParams: params,
  };
}
