/**
 * Bitbucket on-demand Pipelines CI Provider.
 *
 * Implements the CIProvider interface using Bitbucket's on-demand pipelines
 * API (announced 2026-04-22).  Unlike the legacy BitbucketPipelinesProvider,
 * this provider does NOT require a separate "hub" repository with a
 * bitbucket-pipelines.yml file: the YAML pipeline definition is POSTed
 * directly to the API at request time.
 *
 * Endpoint : POST /2.0/repositories/{ws}/{repo}/pipelines/{queryString}
 * Headers  : Content-Type: application/yaml
 * Body     : raw YAML pipeline definition
 * Query    : target.ref_type=branch&target.ref_name=…&
 *            target.selector.type=default&variables.<KEY>=<value>…
 *
 * Payload + query-string construction is delegated to the shared
 * buildOndemandRequest() helper.
 */

import api, { route } from '@forge/api';
import type { CIProvider, BuildPayload, BuildResult } from '../interfaces/CIProvider';
import { CIProviderError } from '../interfaces/CIProviderError';
import type { AppConfig, DispatchContext } from '../types';
import { buildOndemandRequest } from '../ondemandPipelinePayload';

/** Provider name used for CIProviderError messages. */
const PROVIDER_NAME = 'Bitbucket Pipelines (on-demand)';

export class BitbucketOndemandProvider implements CIProvider {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  // -----------------------------------------------------------------------
  // CIProvider.triggerBuild
  // -----------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async triggerBuild(_payload: BuildPayload, context: DispatchContext): Promise<BuildResult> {
    // Build + validate the on-demand request.  The helper throws
    // CIProviderError on invalid slug/branch values before we ever touch
    // the network.
    const request = buildOndemandRequest(context, this.config);

    try {
      // Construct the URL using the route tag so each interpolated value is
      // properly URI-encoded by Forge.  The path uses validated workspace/
      // repo slugs; the query string uses one substitution per variable so
      // route can encode commentText/branches with arbitrary characters.
      // The template literal spans multiple lines for readability.
      const url = route`/2.0/repositories/${request.targetWorkspace}/${request.targetRepoSlug}/pipelines/?\
target.ref_type=branch\
&target.ref_name=${request.targetBranch}\
&target.selector.type=default\
&variables.SOURCE_WORKSPACE=${context.workspace}\
&variables.SOURCE_REPO=${context.repoSlug}\
&variables.PR_ID=${String(context.prId)}\
&variables.SOURCE_BRANCH=${context.sourceBranch}\
&variables.COMMENT_TEXT=${context.commentText}\
&variables.COMMENT_AUTHOR=${context.commentAuthor}`;

      const response = await api.asApp().requestBitbucket(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/yaml' },
        body: request.yamlBody,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new CIProviderError(
          PROVIDER_NAME,
          `Failed to trigger on-demand pipeline: ${response.status} – ${body}`,
          response.status,
        );
      }

      // The on-demand API still returns the standard pipeline JSON
      // metadata, so we can extract uuid + build_number to construct a
      // user-facing link the same way as the hub-repo provider.
      const data = (await response.json()) as Record<string, unknown>;
      const pipelineUuid = (data?.uuid as string) ?? '';
      const buildNumber = data?.build_number as number | undefined;

      const buildUrl = buildNumber
        ? `https://bitbucket.org/${request.targetWorkspace}/${request.targetRepoSlug}/pipelines/results/${buildNumber}`
        : undefined;

      return {
        success: true,
        message: `On-demand pipeline triggered in ${request.targetWorkspace}/${request.targetRepoSlug}.`,
        buildId: pipelineUuid || undefined,
        buildUrl,
      };
    } catch (error) {
      // Re-throw CIProviderError as-is; wrap unexpected errors.
      if (error instanceof CIProviderError) {
        throw error;
      }
      throw new CIProviderError(
        PROVIDER_NAME,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // -----------------------------------------------------------------------
  // CIProvider.getBuildStatus
  // -----------------------------------------------------------------------

  async getBuildStatus(buildId: string): Promise<string> {
    // The status endpoint targets the same repository the build was
    // dispatched to.  When ondemandTargetRepo is configured we can poll;
    // otherwise we don't have a stable target repo at status-check time
    // (the spoke context isn't available here) and have to bail out with
    // a clear error.
    if (!this.config.ondemandTargetRepo) {
      throw new CIProviderError(
        PROVIDER_NAME,
        'On-demand target repository must be configured to poll build status. ' +
        'Please set the on-demand target repository in the project settings.',
      );
    }

    // Reuse the helper's parsing/validation so we never splice unsafe
    // values into the URL.
    const parts = this.config.ondemandTargetRepo.trim().split('/').filter((p) => p.length > 0);
    if (parts.length !== 2) {
      throw new CIProviderError(
        PROVIDER_NAME,
        `Invalid target repository "${this.config.ondemandTargetRepo}". Expected "workspace/repo".`,
      );
    }
    const [targetWorkspace, targetRepoSlug] = parts;

    const response = await api
      .asApp()
      .requestBitbucket(
        route`/2.0/repositories/${targetWorkspace}/${targetRepoSlug}/pipelines/${buildId}`,
      );

    if (!response.ok) {
      throw new CIProviderError(
        PROVIDER_NAME,
        `Failed to fetch build status: ${response.status}`,
        response.status,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const state = data?.state as Record<string, unknown> | undefined;
    return (state?.name as string) ?? 'UNKNOWN';
  }
}
