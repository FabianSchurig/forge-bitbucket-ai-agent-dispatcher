import Resolver from '@forge/resolver';
import { getSettings, saveSettings } from './storage';
import { ProviderFactory } from './factories/ProviderFactory';
import { CIProviderError } from './interfaces/CIProviderError';
import type { AppConfig, DispatchContext } from './types';
import type { BuildPayload, BuildResult } from './interfaces/CIProvider';

const resolver = new Resolver();

resolver.define('getSettings', async (): Promise<AppConfig> => {
  return await getSettings();
});

resolver.define('saveSettings', async ({ payload }: { payload: AppConfig }) => {
  await saveSettings(payload);
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
  };
}): Promise<BuildResult> => {
  try {
    const ciProvider = await ProviderFactory.getProvider();

    const buildPayload: BuildPayload = {
      branch: payload.branch,
      repoName: payload.repoSlug,
      workspace: payload.workspace,
      prId: payload.prId,
      commentText: payload.commentText,
      commentAuthor: payload.commentAuthor,
    };

    // Build a minimal DispatchContext for the provider.
    // This is used by providers that need the full context (e.g. Bitbucket Pipelines).
    const context: DispatchContext = {
      workspaceUuid: '',
      repoUuid: '',
      workspace: payload.workspace,
      repoSlug: payload.repoSlug,
      prId: payload.prId,
      sourceBranch: payload.branch,
      commentText: payload.commentText,
      commentAuthor: payload.commentAuthor,
      commentId: 0,
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

/** Resolver handler exported for use in manifest.yml. */
export const handler = resolver.getDefinitions();
