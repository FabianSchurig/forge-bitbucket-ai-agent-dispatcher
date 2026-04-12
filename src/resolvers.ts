import Resolver from '@forge/resolver';
import { getSettings, saveSettings } from './storage';
import { getDispatchEvents } from './monitoring';
import { ProviderFactory } from './factories/ProviderFactory';
import { CIProviderError } from './interfaces/CIProviderError';
import type { AppConfig, DispatchContext, DispatchEvent } from './types';
import type { BuildPayload, BuildResult } from './interfaces/CIProvider';

const resolver = new Resolver();

/**
 * Returns the current configuration for the given project.
 * The UI passes the project UUID from the Forge extension context.
 */
resolver.define('getSettings', async ({ payload }: { payload: { projectUuid?: string } }): Promise<AppConfig> => {
  return await getSettings(payload?.projectUuid);
});

/**
 * Saves configuration scoped to the given project.
 * The UI passes the project UUID from the Forge extension context.
 */
resolver.define('saveSettings', async ({ payload }: { payload: { config: AppConfig; projectUuid?: string } }) => {
  await saveSettings(payload.config, payload.projectUuid);
  return { success: true };
});

/**
 * Starts a deployment via the configured CI/CD provider.
 *
 * The resolver is intentionally thin — it delegates all CI logic to the
 * ProviderFactory (Factory Pattern) which returns the correct CIProvider
 * (Strategy Pattern).  The resolver does not know or care whether the
 * backend is Jenkins, Bitbucket Pipelines, or any future provider.
 */
resolver.define('startDeployment', async ({ payload }: {
  payload: {
    repoSlug: string;
    workspace: string;
    branch: string;
    prId: number;
    commentText: string;
    commentAuthor: string;
    commentId: number;
    projectUuid?: string;
    repoUuid?: string;
  };
}): Promise<BuildResult> => {
  try {
    const ciProvider = await ProviderFactory.getProvider(payload.projectUuid, payload.repoUuid);

    const buildPayload: BuildPayload = {
      branch: payload.branch,
      repoName: payload.repoSlug,
      workspace: payload.workspace,
      prId: payload.prId,
      commentText: payload.commentText,
      commentAuthor: payload.commentAuthor,
      commentId: payload.commentId,
    };

    // Build a minimal DispatchContext for the provider.
    // This is used by providers that need the full context (e.g. Bitbucket Pipelines).
    const context: DispatchContext = {
      workspaceUuid: '',
      repoUuid: payload.repoUuid ?? '',
      projectUuid: payload.projectUuid ?? '',
      workspace: payload.workspace,
      repoSlug: payload.repoSlug,
      prId: payload.prId,
      sourceBranch: payload.branch,
      commentText: payload.commentText,
      commentAuthor: payload.commentAuthor,
      commentId: payload.commentId,
    };

    return await ciProvider.triggerBuild(buildPayload, context);
  } catch (error) {
    if (error instanceof CIProviderError) {
      console.error(`startDeployment: ${error.providerName} failed:`, error.message);
      return { success: false, message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('startDeployment: unexpected error:', message);
    return { success: false, message };
  }
});

/**
 * Returns recent dispatch monitoring events scoped to the given project.
 * The UI passes the project UUID from the Forge extension context so
 * only events relevant to the current project are returned.
 * Returns an empty array when no projectUuid is provided to prevent
 * cross-project metadata leaks.
 */
resolver.define(
  'getMonitoringEvents',
  async ({ payload }: { payload: { projectUuid?: string } }): Promise<DispatchEvent[]> => {
    return await getDispatchEvents(payload?.projectUuid);
  },
);

/** Resolver handler exported for use in manifest.yml. */
export const handler = resolver.getDefinitions();
