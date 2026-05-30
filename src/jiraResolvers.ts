/**
 * Backend resolvers for the Jira issue-context "AI Agent Dispatcher" panel.
 *
 * The panel (src/dispatchPanel.tsx) is a Forge Custom UI Kit view that invokes
 * these resolvers via @forge/bridge.  Each resolver is intentionally thin and
 * delegates the security-relevant work (slug/branch validation, variable
 * encoding) to the shared helpers in src/ondemandPipelinePayload.ts and
 * src/jira/*, so the Jira flow and the PR-comment flow share one source of
 * truth.
 *
 * Authorisation
 * -------------
 * Reads (issue details, repository list) use api.asUser() so Forge enforces the
 * caller's own Jira/Bitbucket permissions — a user can only ever see issues and
 * repositories they are allowed to see.  The branch-create + pipeline-trigger
 * writes use api.asApp() because the Forge app principal is what holds the
 * write:repository / write:pipeline scopes; user-level gating for those costly
 * actions is provided by the panel's manifest display conditions.
 */

import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { getSettings } from './storage';
import { buildBranchName, sanitizeBranch } from './jira/branchName';
import { buildJiraDispatchRequest } from './jira/jiraDispatch';
import { validateSlug } from './ondemandPipelinePayload';
import { CIProviderError } from './interfaces/CIProviderError';

const PROVIDER_NAME = 'Jira AI Agent Dispatch';

/** A repository entry returned to the panel's repository selector. */
export interface RepositoryOption {
  /** Workspace slug (e.g. "my-team"). */
  workspace: string;
  /** Repository slug (e.g. "my-service"). */
  repoSlug: string;
  /** "{workspace}/{repo}" convenience label for the dropdown. */
  fullName: string;
}

/** Context returned to the panel describing the active Jira issue. */
export interface JiraContext {
  issueKey: string;
  summary: string;
  /** A ready-to-use, injection-safe branch name derived from the summary. */
  suggestedBranch: string;
}

/** Result of a dispatch attempt, surfaced directly in the panel UI. */
export interface DispatchAgentResult {
  success: boolean;
  message: string;
  branch?: string;
  pipelineId?: string;
  buildUrl?: string;
}

const resolver = new Resolver();

/**
 * Step 3.2 — Returns the active issue's key + summary and a suggested branch.
 *
 * The issue summary is read with requestJira (asUser) so the caller's Jira
 * permissions apply.  The summary is immediately turned into a safe branch
 * suggestion via buildBranchName().
 */
resolver.define(
  'getJiraContext',
  async ({ payload }: { payload: { issueKey?: string } }): Promise<JiraContext> => {
    const issueKey = (payload?.issueKey ?? '').trim();
    if (!issueKey) {
      throw new CIProviderError(PROVIDER_NAME, 'No Jira issue key was provided.');
    }

    const response = await api
      .asUser()
      .requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary`);

    if (!response.ok) {
      const body = await response.text();
      throw new CIProviderError(
        PROVIDER_NAME,
        `Failed to load Jira issue ${issueKey}: ${response.status} – ${body}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const fields = (data?.fields as Record<string, unknown> | undefined) ?? {};
    const summary = (fields.summary as string) ?? '';

    return {
      issueKey,
      summary,
      suggestedBranch: buildBranchName(issueKey, summary),
    };
  },
);

/**
 * Step 3.3 — Lists the Bitbucket repositories the calling user can access.
 *
 * Uses requestBitbucket (asUser) with `role=member` so only repositories the
 * user actually belongs to are returned, then flattens the response into a
 * compact shape for the panel's repository selector.
 */
resolver.define('fetchRepositories', async (): Promise<RepositoryOption[]> => {
  const response = await api
    .asUser()
    .requestBitbucket(
      route`/2.0/repositories?role=member&pagelen=100&sort=-updated_on&fields=values.slug,values.full_name,values.workspace.slug`,
    );

  if (!response.ok) {
    const body = await response.text();
    throw new CIProviderError(
      PROVIDER_NAME,
      `Failed to list repositories: ${response.status} – ${body}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  const values = (data?.values as Array<Record<string, unknown>>) ?? [];

  return values.map((repo) => {
    const workspace = (repo?.workspace as Record<string, unknown> | undefined)?.slug as string;
    return {
      workspace: workspace ?? '',
      repoSlug: (repo?.slug as string) ?? '',
      fullName: (repo?.full_name as string) ?? '',
    };
  });
});

/**
 * Step 3.4 — Creates the branch (if needed) then triggers the agent pipeline.
 *
 * The two writes run sequentially: a branch must exist before a pipeline can be
 * dispatched against it.  All Jira metadata is forwarded strictly as pipeline
 * variables (never concatenated into shell), and the branch name is derived via
 * the injection-safe slugifier.  Errors are returned as a structured failure
 * result rather than thrown so the panel can show a friendly message.
 */
resolver.define(
  'dispatchAgent',
  async ({
    payload,
  }: {
    payload: {
      workspace?: string;
      repoSlug?: string;
      issueKey?: string;
      issueSummary?: string;
      branch?: string;
      projectUuid?: string;
    };
  }): Promise<DispatchAgentResult> => {
    try {
      const workspace = (payload?.workspace ?? '').trim();
      const repoSlug = (payload?.repoSlug ?? '').trim();
      const issueKey = (payload?.issueKey ?? '').trim();
      const issueSummary = payload?.issueSummary ?? '';

      // Validate the slugs up front so we never build an API path from unsafe
      // input. This throws CIProviderError, caught below.
      validateSlug(workspace, 'workspace slug', PROVIDER_NAME);
      validateSlug(repoSlug, 'repository slug', PROVIDER_NAME);

      // Use the caller's chosen branch (sanitised, preserving their intent) if
      // one was supplied, otherwise derive a safe branch from the issue.
      const branch =
        payload?.branch && payload.branch.trim().length > 0
          ? sanitizeBranch(payload.branch)
          : buildBranchName(issueKey, issueSummary);

      const config = await getSettings(payload?.projectUuid);

      await createBranch(workspace, repoSlug, branch);

      const request = buildJiraDispatchRequest(
        { workspace, repoSlug, branch, issueKey, issueSummary },
        config,
      );

      const pipelineResponse = await api.asApp().requestBitbucket(
        route`/2.0/repositories/${request.targetWorkspace}/${request.targetRepoSlug}/pipelines?${request.queryParams}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/yaml' },
          body: request.yamlBody,
        },
      );

      if (!pipelineResponse.ok) {
        const body = await pipelineResponse.text();
        throw new CIProviderError(
          PROVIDER_NAME,
          `Failed to trigger pipeline: ${pipelineResponse.status} – ${body}`,
        );
      }

      const data = (await pipelineResponse.json()) as Record<string, unknown>;
      const pipelineId = (data?.uuid as string) || undefined;
      const buildNumber = data?.build_number as number | undefined;
      const buildUrl = buildNumber
        ? `https://bitbucket.org/${workspace}/${repoSlug}/pipelines/results/${buildNumber}`
        : undefined;

      return {
        success: true,
        message: `Agent pipeline started on branch ${branch}.`,
        branch,
        pipelineId,
        buildUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('dispatchAgent failed:', message);
      return { success: false, message };
    }
  },
);

/**
 * Creates a branch from the repository's main branch.
 *
 * Idempotent: if Bitbucket reports the branch already exists (HTTP 409) we
 * treat that as success so re-dispatching onto the same issue branch works.
 */
async function createBranch(
  workspace: string,
  repoSlug: string,
  branch: string,
): Promise<void> {
  // Look up the repo's default branch to use as the new branch's base.
  const repoResponse = await api
    .asApp()
    .requestBitbucket(route`/2.0/repositories/${workspace}/${repoSlug}`);

  if (!repoResponse.ok) {
    const body = await repoResponse.text();
    throw new CIProviderError(
      PROVIDER_NAME,
      `Failed to load repository ${workspace}/${repoSlug}: ${repoResponse.status} – ${body}`,
    );
  }

  const repoData = (await repoResponse.json()) as Record<string, unknown>;
  const mainBranch =
    ((repoData?.mainbranch as Record<string, unknown> | undefined)?.name as string) ?? 'main';

  const createResponse = await api.asApp().requestBitbucket(
    route`/2.0/repositories/${workspace}/${repoSlug}/refs/branches`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: branch, target: { hash: mainBranch } }),
    },
  );

  // 409 = branch already exists; that is fine for an idempotent dispatch.
  if (!createResponse.ok && createResponse.status !== 409) {
    const body = await createResponse.text();
    throw new CIProviderError(
      PROVIDER_NAME,
      `Failed to create branch ${branch}: ${createResponse.status} – ${body}`,
    );
  }
}

/** Resolver handler exported for use in manifest.yml (index.jiraResolver). */
export const handler = resolver.getDefinitions();
