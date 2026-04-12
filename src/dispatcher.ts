import api, { route } from '@forge/api';
import { getSettings } from './storage';
import { ProviderFactory } from './factories/ProviderFactory';
import { CIProviderError } from './interfaces/CIProviderError';
import { recordDispatchEvent } from './monitoring';
import type {
  AppConfig,
  DispatchContext,
  PipelinePayload,
} from './types';
import type { BuildPayload } from './interfaces/CIProvider';

// Re-export the shared helper so existing tests and callers keep working.
export { buildPipelinePayload } from './pipelinePayload';

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

  // Extract the project UUID from the repository object.
  // Bitbucket associates repositories with projects; the event payload
  // includes the project context under repository.project.uuid.
  const project = repository?.project as Record<string, unknown> | undefined;
  const projectUuid = (project?.uuid as string) ?? '';

  // The Forge event includes source branch info directly on the pullrequest.
  // The branch field can be either a plain string or an object { name: "…" }
  // depending on the Bitbucket API version, so we handle both shapes.
  const source = pullrequest?.source as Record<string, unknown> | undefined;
  const rawBranch = source?.branch;
  const sourceBranch =
    typeof rawBranch === 'string'
      ? rawBranch
      : ((rawBranch as Record<string, unknown> | undefined)?.name as string | undefined) ?? '';

  if (!workspaceUuid || !repoUuid || !prId || !commentId) {
    return null;
  }

  return {
    workspaceUuid,
    repoUuid,
    projectUuid,
    workspace: '',      // populated via fetchRepositoryDetails
    repoSlug: '',       // populated via fetchRepositoryDetails
    prId,
    sourceBranch,
    commentText: '',    // populated via fetchCommentContent
    commentAuthor,
    commentId,
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

/**
 * Posts a success reply to the original PR comment with a link to the
 * triggered pipeline/build.  This gives the user immediate feedback about
 * where to follow the agent session progress.
 *
 * Errors are swallowed so that a secondary failure does not obscure the
 * successful dispatch — the build has already been triggered at this point.
 */
export async function postSuccessComment(
  workspaceUuid: string,
  repoUuid: string,
  prId: number,
  commentId: number,
  buildUrl?: string,
): Promise<void> {
  try {
    // When a build URL is available, include a clickable link.
    // Otherwise fall back to a generic confirmation message.
    const message = buildUrl
      ? `Agent build started: [View build](${buildUrl})`
      : 'Agent build started successfully.';

    const body: Record<string, unknown> = {
      content: { raw: message },
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
      console.error('Failed to post success comment:', await response.text());
    }
  } catch (err) {
    console.error('Error posting success comment:', err);
  }
}

// ---------------------------------------------------------------------------
// Main trigger handler
// ---------------------------------------------------------------------------

/**
 * Forge trigger handler for the `avi:bitbucket:created:pullrequest-comment`
 * event.  Fetches comment content and repo details (since the Forge event
 * only provides UUIDs and IDs), checks for the configured trigger keyword,
 * and dispatches a build via the configured CI/CD provider (Strategy Pattern).
 *
 * The dispatcher is completely decoupled from the CI backend — it delegates
 * to the ProviderFactory which returns the correct CIProvider implementation
 * based on the project-scoped configuration.
 *
 * Configuration is resolved in order: repo override → project → legacy global.
 */
export async function runDispatcher(event: Record<string, unknown>): Promise<void> {
  // Log only safe, non-sensitive identifiers — never the full event payload.
  const eventKeys = Object.keys(event).join(', ');
  console.log(`Dispatcher: received event with keys [${eventKeys}]`);

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
    `(workspace=${context.workspaceUuid}, repo=${context.repoUuid}, ` +
    `project=${context.projectUuid || 'none'}).`,
  );

  // Load config early so we can check monitoringEnabled for all code paths.
  let config: AppConfig | undefined;

  try {
    // Fetch comment content (not included in the Forge event payload).
    const commentText = await fetchCommentContent(
      context.workspaceUuid,
      context.repoUuid,
      context.prId,
      context.commentId,
    );
    context.commentText = commentText;

    // Use project-scoped config with optional repo-level override.
    config = await getSettings(context.projectUuid, context.repoUuid);

    if (!context.commentText.includes(config.triggerKeyword)) {
      console.log(
        `Dispatcher: trigger keyword "${config.triggerKeyword}" not found in comment – skipping.`,
      );

      // Record a SKIPPED monitoring event when monitoring is enabled.
      if (config.monitoringEnabled) {
        await recordDispatchEvent({
          timestamp: new Date().toISOString(),
          projectUuid: context.projectUuid,
          workspaceUuid: context.workspaceUuid,
          repoUuid: context.repoUuid,
          prId: context.prId,
          commentId: context.commentId,
          status: 'SKIPPED',
          provider: '',
          message: `Trigger keyword "${config.triggerKeyword}" not found in comment.`,
        });
      }
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

    // Build a generic BuildPayload from the dispatch context.
    const buildPayload: BuildPayload = {
      branch: context.sourceBranch,
      repoName: context.repoSlug,
      workspace: context.workspace,
      prId: context.prId,
      commentText: context.commentText,
      commentAuthor: context.commentAuthor,
      commentId: context.commentId,
    };

    // Use the ProviderFactory to get the configured CI provider (Strategy Pattern).
    // The dispatcher does not know or care whether this is Jenkins, Pipelines, etc.
    // Configuration is resolved: repo override → project → legacy global.
    const ciProvider = await ProviderFactory.getProvider(context.projectUuid, context.repoUuid);
    const result = await ciProvider.triggerBuild(buildPayload, context);

    console.log(
      `Dispatcher: ${result.message}`,
    );

    // Post a reply to the triggering comment with a link to the pipeline.
    // This gives the user immediate feedback about where to follow progress.
    await postSuccessComment(
      context.workspaceUuid,
      context.repoUuid,
      context.prId,
      context.commentId,
      result.buildUrl,
    );

    // Record a SUCCESS monitoring event when monitoring is enabled.
    if (config.monitoringEnabled) {
      await recordDispatchEvent({
        timestamp: new Date().toISOString(),
        projectUuid: context.projectUuid,
        workspaceUuid: context.workspaceUuid,
        repoUuid: context.repoUuid,
        prId: context.prId,
        commentId: context.commentId,
        status: 'SUCCESS',
        provider: config.ciType,
        message: result.message,
        buildUrl: result.buildUrl,
      });
    }
  } catch (error) {
    // Log the specific provider name if available via CIProviderError.
    if (error instanceof CIProviderError) {
      console.error(`Dispatcher: ${error.providerName} failed:`, error.message);
    } else {
      console.error('Dispatcher: failed to dispatch build:', error);
    }

    await postFailureComment(
      context.workspaceUuid,
      context.repoUuid,
      context.prId,
      context.commentId,
    );

    // Record a FAILURE monitoring event when monitoring is enabled.
    if (config?.monitoringEnabled) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await recordDispatchEvent({
        timestamp: new Date().toISOString(),
        projectUuid: context.projectUuid,
        workspaceUuid: context.workspaceUuid,
        repoUuid: context.repoUuid,
        prId: context.prId,
        commentId: context.commentId,
        status: 'FAILURE',
        provider: config.ciType,
        message: errMsg,
      });
    }
  }
}
