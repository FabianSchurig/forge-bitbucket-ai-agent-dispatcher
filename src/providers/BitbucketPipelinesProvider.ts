/**
 * Bitbucket Pipelines CI Provider.
 *
 * Implements the CIProvider interface for Bitbucket Pipelines.
 * This provider triggers a custom pipeline in a "hub" repository via the
 * Bitbucket REST API, using Forge's built-in app authentication.
 *
 * Pipeline payload construction is delegated to the shared
 * buildPipelinePayload() helper in dispatcher.ts to avoid duplication.
 */

import api, { route } from '@forge/api';
import type { CIProvider, BuildPayload, BuildResult } from '../interfaces/CIProvider';
import { CIProviderError } from '../interfaces/CIProviderError';
import type { AppConfig, DispatchContext } from '../types';
import { buildPipelinePayload } from '../pipelinePayload';

export class BitbucketPipelinesProvider implements CIProvider {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  // -----------------------------------------------------------------------
  // CIProvider.triggerBuild
  // -----------------------------------------------------------------------

  async triggerBuild(payload: BuildPayload, context: DispatchContext): Promise<BuildResult> {
    // Determine the effective hub workspace: fall back to the spoke workspace
    // when the admin left hubWorkspace blank.
    const hubWorkspace = this.config.hubWorkspace || payload.workspace;

    // Reuse the shared pipeline payload builder to avoid drift between
    // this provider and the legacy triggerPipeline() helper.
    const pipelinePayload = buildPipelinePayload(context, this.config);

    try {
      const response = await api
        .asApp()
        .requestBitbucket(
          route`/2.0/repositories/${hubWorkspace}/${this.config.hubRepository}/pipelines/`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pipelinePayload),
          },
        );

      if (!response.ok) {
        const body = await response.text();
        throw new CIProviderError(
          'Bitbucket Pipelines',
          `Failed to trigger pipeline: ${response.status} – ${body}`,
          response.status,
        );
      }

      // Parse the response to extract the pipeline UUID and build number.
      // The Bitbucket Pipelines API returns a JSON body that includes the
      // pipeline UUID (uuid) and build_number, which we use to construct
      // a direct link so the user can navigate to the pipeline run.
      const data = (await response.json()) as Record<string, unknown>;
      const pipelineUuid = (data?.uuid as string) ?? '';
      const buildNumber = data?.build_number as number | undefined;

      // Construct the user-visible URL for the pipeline run.
      // Format: https://bitbucket.org/{workspace}/{repo}/pipelines/results/{buildNumber}
      const buildUrl = buildNumber
        ? `https://bitbucket.org/${hubWorkspace}/${this.config.hubRepository}/pipelines/results/${buildNumber}`
        : undefined;

      return {
        success: true,
        message: `Pipeline triggered in ${hubWorkspace}/${this.config.hubRepository}.`,
        buildId: pipelineUuid || undefined,
        buildUrl,
      };
    } catch (error) {
      // Re-throw CIProviderError instances as-is; wrap unexpected errors.
      if (error instanceof CIProviderError) {
        throw error;
      }
      throw new CIProviderError(
        'Bitbucket Pipelines',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // -----------------------------------------------------------------------
  // CIProvider.getBuildStatus
  // -----------------------------------------------------------------------

  async getBuildStatus(buildId: string): Promise<string> {
    // hubWorkspace must be explicitly configured to poll build status.
    // When left blank in the config, there is no reliable workspace slug
    // available (we don't have the spoke payload at status-check time).
    const hubWorkspace = this.config.hubWorkspace;
    if (!hubWorkspace) {
      throw new CIProviderError(
        'Bitbucket Pipelines',
        'Hub workspace must be configured to poll build status. ' +
        'Please set the hub workspace slug in the project settings.',
      );
    }

    const response = await api
      .asApp()
      .requestBitbucket(
        route`/2.0/repositories/${hubWorkspace}/${this.config.hubRepository}/pipelines/${buildId}`,
      );

    if (!response.ok) {
      throw new CIProviderError(
        'Bitbucket Pipelines',
        `Failed to fetch build status: ${response.status}`,
        response.status,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const state = data?.state as Record<string, unknown> | undefined;
    return (state?.name as string) ?? 'UNKNOWN';
  }
}
