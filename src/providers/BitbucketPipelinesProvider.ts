/**
 * Bitbucket Pipelines CI Provider.
 *
 * Implements the CIProvider interface for Bitbucket Pipelines.
 * This provider triggers a custom pipeline in a "hub" repository via the
 * Bitbucket REST API, using Forge's built-in app authentication.
 *
 * It encapsulates the existing triggerPipeline + buildPipelinePayload logic
 * that was previously inlined in the dispatcher, so the dispatcher no longer
 * needs to know anything about the Bitbucket Pipelines API shape.
 */

import api, { route } from '@forge/api';
import type { CIProvider, BuildPayload, BuildResult } from '../interfaces/CIProvider';
import { CIProviderError } from '../interfaces/CIProviderError';
import type { AppConfig, DispatchContext, PipelinePayload } from '../types';

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

    const pipelinePayload = this.buildPipelinePayload(context);

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

      return {
        success: true,
        message: `Pipeline triggered in ${hubWorkspace}/${this.config.hubRepository}.`,
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
    const hubWorkspace = this.config.hubWorkspace || '';
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

  // -----------------------------------------------------------------------
  // Internal helper: builds the Bitbucket Pipelines API JSON body.
  // -----------------------------------------------------------------------

  private buildPipelinePayload(context: DispatchContext): PipelinePayload {
    // Strip the "custom: " prefix so we only pass the pipeline pattern name.
    const pipelineName = this.config.hubPipeline.replace(/^custom:\s*/i, '');

    return {
      target: {
        type: 'pipeline_ref_target',
        ref_type: 'branch',
        ref_name: this.config.pipelineBranch,
        selector: {
          type: 'custom',
          pattern: pipelineName,
        },
      },
      variables: [
        { key: 'SOURCE_WORKSPACE', value: context.workspace },
        { key: 'SOURCE_REPO', value: context.repoSlug },
        { key: 'PR_ID', value: String(context.prId) },
        { key: 'SOURCE_BRANCH', value: context.sourceBranch },
        { key: 'COMMENT_TEXT', value: context.commentText },
        { key: 'COMMENT_AUTHOR', value: context.commentAuthor },
      ],
    };
  }
}
