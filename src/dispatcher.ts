import api, { route } from '@forge/api';
import { getSettings } from './storage';
import {
  AppConfig,
  DispatchContext,
  PipelinePayload,
} from './types';

// ---------------------------------------------------------------------------
// Pure helpers (easily unit-tested without mocking Forge APIs)
// ---------------------------------------------------------------------------

/**
 * Extracts the relevant context from a raw Forge Bitbucket comment-event
 * payload.  Returns null if required fields are missing.
 */
export function extractTriggerContext(event: Record<string, unknown>): DispatchContext | null {
  const comment = event?.comment as Record<string, unknown> | undefined;
  const pullrequest = event?.pullrequest as Record<string, unknown> | undefined;
  const repository = event?.repository as Record<string, unknown> | undefined;
  const actor = event?.actor as Record<string, unknown> | undefined;
  const workspace = repository?.workspace as Record<string, unknown> | undefined;

  const commentText = (comment?.content as Record<string, unknown> | undefined)?.raw as string ?? '';
  const workspaceSlug = workspace?.slug as string ?? '';
  const repoSlug = repository?.slug as string ?? '';
  const prId = pullrequest?.id as number ?? 0;
  const commentId = comment?.id as number ?? 0;
  const commentAuthor =
    (actor?.account_id as string) ??
    (actor?.display_name as string) ??
    'unknown';

  if (!workspaceSlug || !repoSlug || !prId) {
    return null;
  }

  return {
    workspace: workspaceSlug,
    repoSlug,
    prId,
    sourceBranch: '', // populated after fetching PR details
    commentText,
    commentAuthor,
    commentId,
  };
}

/**
 * Builds the JSON payload for the Bitbucket Pipelines API.
 */
export function buildPipelinePayload(
  context: DispatchContext,
  config: AppConfig,
): PipelinePayload {
  // Strip the "custom: " prefix so we only pass the pipeline pattern name.
  const pipelineName = config.hubPipeline.replace(/^custom:\s*/i, '');

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

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * Fetches PR details from the Bitbucket API and returns the source branch name.
 */
export async function fetchPRDetails(
  workspace: string,
  repoSlug: string,
  prId: number,
): Promise<{ sourceBranch: string }> {
  const response = await api
    .asApp()
    .requestBitbucket(
      route`/2.0/repositories/${workspace}/${repoSlug}/pullrequests/${prId}`,
    );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch PR details: ${response.status} – ${body}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const source = data?.source as Record<string, unknown> | undefined;
  const branch = source?.branch as Record<string, unknown> | undefined;
  const sourceBranch = (branch?.name as string) ?? '';

  return { sourceBranch };
}

/**
 * Triggers a custom pipeline in the hub repository.
 */
export async function triggerPipeline(
  hubWorkspace: string,
  hubRepository: string,
  payload: PipelinePayload,
): Promise<void> {
  const response = await api
    .asApp()
    .requestBitbucket(
      route`/2.0/repositories/${hubWorkspace}/${hubRepository}/pipelines/`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to trigger pipeline: ${response.status} – ${body}`);
  }
}

/**
 * Posts a failure notice as a reply to the original PR comment.
 * Errors are swallowed so that a secondary failure does not obscure the
 * primary error.
 */
export async function postFailureComment(
  workspace: string,
  repoSlug: string,
  prId: number,
  commentId: number,
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      content: {
        raw: 'Failed to trigger agent pipeline. Please check configuration.',
      },
    };
    if (commentId) {
      body.parent = { id: commentId };
    }

    const response = await api
      .asApp()
      .requestBitbucket(
        route`/2.0/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

    if (!response.ok) {
      console.error('Failed to post failure comment:', await response.text());
    }
  } catch (err) {
    console.error('Error posting failure comment:', err);
  }
}

// ---------------------------------------------------------------------------
// Main trigger handler
// ---------------------------------------------------------------------------

/**
 * Forge trigger handler for the `avi:bitbucket:created:pullrequest:comment`
 * event.  Checks for the configured trigger keyword, fetches PR context and
 * dispatches a pipeline in the hub repository.
 */
export async function runDispatcher(event: Record<string, unknown>): Promise<void> {
  const context = extractTriggerContext(event);

  if (!context) {
    console.log('Dispatcher: invalid or incomplete event payload – skipping.');
    return;
  }

  const config = await getSettings();

  if (!context.commentText.includes(config.triggerKeyword)) {
    console.log(
      `Dispatcher: trigger keyword "${config.triggerKeyword}" not found in comment – skipping.`,
    );
    return;
  }

  console.log(
    `Dispatcher: keyword detected in PR #${context.prId} ` +
    `(${context.workspace}/${context.repoSlug}) – dispatching pipeline.`,
  );

  try {
    const { sourceBranch } = await fetchPRDetails(
      context.workspace,
      context.repoSlug,
      context.prId,
    );
    context.sourceBranch = sourceBranch;

    const hubWorkspace = config.hubWorkspace || context.workspace;
    const effectiveConfig: AppConfig = { ...config, hubWorkspace };
    const payload = buildPipelinePayload(context, effectiveConfig);

    await triggerPipeline(hubWorkspace, config.hubRepository, payload);

    console.log(
      `Dispatcher: pipeline successfully triggered in ` +
      `${hubWorkspace}/${config.hubRepository}.`,
    );
  } catch (error) {
    console.error('Dispatcher: failed to dispatch pipeline:', error);
    await postFailureComment(
      context.workspace,
      context.repoSlug,
      context.prId,
      context.commentId,
    );
  }
}
