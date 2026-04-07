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
 * Extracts the relevant context from a Forge Bitbucket
 * `avi:bitbucket:created:pullrequest-comment` event payload.
 *
 * The Forge event only provides UUIDs for workspace/repository and an ID
 * for the comment (no slug, no comment content).  Slugs and comment text
 * are populated later via Bitbucket REST API calls.
 *
 * Returns null if required fields are missing.
 */
export function extractTriggerContext(event: Record<string, unknown>): DispatchContext | null {
  const comment = event?.comment as Record<string, unknown> | undefined;
  const pullrequest = event?.pullrequest as Record<string, unknown> | undefined;
  const repository = event?.repository as Record<string, unknown> | undefined;
  const workspace = event?.workspace as Record<string, unknown> | undefined;
  const actor = event?.actor as Record<string, unknown> | undefined;

  const workspaceUuid = (workspace?.uuid as string) ?? '';
  const repoUuid = (repository?.uuid as string) ?? '';
  const prId = (pullrequest?.id as number) ?? 0;
  const commentId = (comment?.id as number) ?? 0;
  const commentAuthor = (actor?.accountId as string) ?? (actor?.uuid as string) ?? 'unknown';

  // The Forge event includes source branch info directly on the pullrequest.
  const source = pullrequest?.source as Record<string, unknown> | undefined;
  const sourceBranch = (source?.branch as string) ?? '';

  if (!workspaceUuid || !repoUuid || !prId || !commentId) {
    return null;
  }

  return {
    workspaceUuid,
    repoUuid,
    workspace: '',      // populated via fetchRepositoryDetails
    repoSlug: '',       // populated via fetchRepositoryDetails
    prId,
    sourceBranch,
    commentText: '',    // populated via fetchCommentContent
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
 * Fetches repository details via the Bitbucket API using UUIDs.
 * Returns the workspace slug and repo slug needed for pipeline variables
 * and subsequent API calls.
 */
export async function fetchRepositoryDetails(
  workspaceUuid: string,
  repoUuid: string,
): Promise<{ workspaceSlug: string; repoSlug: string }> {
  const response = await api
    .asApp()
    .requestBitbucket(
      route`/2.0/repositories/${workspaceUuid}/${repoUuid}`,
    );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch repository details: ${response.status} – ${body}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const repoSlug = (data?.slug as string) ?? '';
  const ws = data?.workspace as Record<string, unknown> | undefined;
  const workspaceSlug = (ws?.slug as string) ?? '';

  return { workspaceSlug, repoSlug };
}

/**
 * Fetches the raw content of a PR comment from the Bitbucket API.
 * The Forge event only includes the comment ID, so we need a separate
 * API call to get the actual text.
 */
export async function fetchCommentContent(
  workspaceUuid: string,
  repoUuid: string,
  prId: number,
  commentId: number,
): Promise<string> {
  const response = await api
    .asApp()
    .requestBitbucket(
      route`/2.0/repositories/${workspaceUuid}/${repoUuid}/pullrequests/${prId}/comments/${commentId}`,
    );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch comment content: ${response.status} – ${body}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const content = data?.content as Record<string, unknown> | undefined;
  return (content?.raw as string) ?? '';
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
 * Uses UUIDs for the API path since slugs may not yet be available.
 * Errors are swallowed so that a secondary failure does not obscure the
 * primary error.
 */
export async function postFailureComment(
  workspaceUuid: string,
  repoUuid: string,
  prId: number,
  commentId: number,
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      content: {
        raw: 'Failed to trigger agent pipeline. Please check configuration.',
      },
    };
    if (commentId > 0) {
      body.parent = { id: commentId };
    }

    const response = await api
      .asApp()
      .requestBitbucket(
        route`/2.0/repositories/${workspaceUuid}/${repoUuid}/pullrequests/${prId}/comments`,
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
 * Forge trigger handler for the `avi:bitbucket:created:pullrequest-comment`
 * event.  Fetches comment content and repo details (since the Forge event
 * only provides UUIDs and IDs), checks for the configured trigger keyword,
 * and dispatches a pipeline in the hub repository.
 */
export async function runDispatcher(event: Record<string, unknown>): Promise<void> {
  console.log('Dispatcher: received event', JSON.stringify(event));

  // Skip events generated by this app itself (e.g. failure comment replies).
  if (event?.selfGenerated === true) {
    console.log('Dispatcher: ignoring self-generated event – skipping.');
    return;
  }

  const context = extractTriggerContext(event);

  if (!context) {
    console.log('Dispatcher: invalid or incomplete event payload – skipping.');
    return;
  }

  console.log(
    `Dispatcher: PR #${context.prId}, comment #${context.commentId} ` +
    `(workspace=${context.workspaceUuid}, repo=${context.repoUuid}).`,
  );

  try {
    // Fetch comment content (not included in the Forge event payload).
    const commentText = await fetchCommentContent(
      context.workspaceUuid,
      context.repoUuid,
      context.prId,
      context.commentId,
    );
    context.commentText = commentText;

    const config = await getSettings();

    if (!context.commentText.includes(config.triggerKeyword)) {
      console.log(
        `Dispatcher: trigger keyword "${config.triggerKeyword}" not found in comment – skipping.`,
      );
      return;
    }

    console.log(
      `Dispatcher: keyword "${config.triggerKeyword}" detected – resolving repo details.`,
    );

    // Fetch repo/workspace slugs (not included in the Forge event payload).
    const { workspaceSlug, repoSlug } = await fetchRepositoryDetails(
      context.workspaceUuid,
      context.repoUuid,
    );
    context.workspace = workspaceSlug;
    context.repoSlug = repoSlug;

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
      context.workspaceUuid,
      context.repoUuid,
      context.prId,
      context.commentId,
    );
  }
}
