/**
 * Shared helper for constructing the Bitbucket Pipelines API JSON body.
 *
 * Extracted into its own module so both the legacy `triggerPipeline()` helper
 * in `dispatcher.ts` and the `BitbucketPipelinesProvider` can reuse the same
 * logic, preventing drift between the two code paths.
 */

import type { AppConfig, DispatchContext, PipelinePayload } from './types';

/**
 * Builds the JSON payload for the Bitbucket Pipelines API.
 */
export function buildPipelinePayload(
  context: DispatchContext,
  config: AppConfig,
): PipelinePayload {
  // Strip the "custom: " prefix so we only pass the pipeline pattern name.
  const pipelineName = config.hubPipeline.replace(/^custom:\s*/i, '');

  // COMMENT_TEXT is included in the Bitbucket Pipelines payload as a POST
  // body variable — this is safe because the data is sent over an encrypted
  // channel in a JSON body (never exposed in URL/proxy logs).  The Jenkins
  // provider intentionally excludes comment text from URL query parameters
  // for security reasons and sends only COMMENT_ID instead.
  return {
    target: {
      type: 'pipeline_ref_target',
      ref_type: 'branch',
      ref_name: config.pipelineBranch,
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
