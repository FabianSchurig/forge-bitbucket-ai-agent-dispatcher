/**
 * Bitbucket on-demand Pipelines CI Provider.
 *
 * Implements the CIProvider interface using Bitbucket's on-demand pipelines
 * API (announced 2026-04-22).  Unlike the legacy BitbucketPipelinesProvider,
 * this provider does NOT require a separate "hub" repository with a
 * bitbucket-pipelines.yml file: the YAML pipeline definition is POSTed
 * directly to the API at request time.
 *
 * Endpoint : POST /2.0/repositories/{ws}/{repo}/pipelines{queryString}
 * Headers  : Content-Type: application/yaml
 * Body     : raw YAML pipeline definition
 * Query    : target.type=pipeline_ref_target&target.ref_type=branch&
 *            target.ref_name=…&variables[0].key=<KEY>&variables[0].value=<value>…
 *
 * Authentication
 * --------------
 * Requests are made via `api.asApp().requestBitbucket()`.  The Bitbucket
 * on-demand endpoint requires the Forge app to hold both
 * `read/write:pipeline:bitbucket` *and* `write:repository:bitbucket` —
 * the latter is what satisfies Bitbucket's per-branch write-permission
 * check on the target ref.  On branches covered by a branch restriction
 * the Forge app principal additionally needs to be on that restriction's
 * allow list.
 *
 * Payload + query-string construction is delegated to the shared
 * buildOndemandRequest() helper.
 */

import api, { route } from '@forge/api';
import type { CIProvider, BuildPayload, BuildResult } from '../interfaces/CIProvider';
import { CIProviderError } from '../interfaces/CIProviderError';
import type { AppConfig, DispatchContext } from '../types';
import { buildOndemandRequest, parseTargetRepo } from '../ondemandPipelinePayload';

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
    // the network, and produces the URLSearchParams we embed below so URL
    // construction lives in exactly one place (no drift between the
    // helper's encoding and the provider's URL building).
    const request = buildOndemandRequest(context, this.config);

    try {
      const url = route`/2.0/repositories/${request.targetWorkspace}/${request.targetRepoSlug}/pipelines?${request.queryParams}`;
      const response = await api.asApp().requestBitbucket(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/yaml' },
        body: request.yamlBody,
      });

      if (!response.ok) {
        const body = await response.text();
        const permissionHint = response.status === 403
          ? ' Verify the Forge app has the write:repository:bitbucket scope and, if the target branch has a branch restriction, that the Forge app is on its allow list.'
          : '';
        throw new CIProviderError(
          PROVIDER_NAME,
          `Failed to trigger on-demand pipeline: ${response.status} – ${body}${permissionHint}`,
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

    // Reuse the shared parseTargetRepo() helper so getBuildStatus enforces
    // the exact same slug allowlist + error messages as triggerBuild().
    const { workspace: targetWorkspace, repoSlug: targetRepoSlug } = parseTargetRepo(
      this.config.ondemandTargetRepo.trim(),
    );

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
