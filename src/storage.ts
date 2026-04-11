import kvs from '@forge/kvs';
import { AppConfig, DEFAULT_CONFIG } from './types';

/**
 * Legacy global storage key used before the project-scoped migration.
 * Kept only for one-time fallback reads during migration.
 */
const LEGACY_STORAGE_KEY = 'appConfig';

/**
 * Builds the Forge Storage key for a project-scoped config.
 * All configuration is namespaced by the Bitbucket project UUID so
 * different projects in the same workspace can use different CI backends.
 */
function projectKey(projectUuid: string): string {
  return `dispatch-config-${projectUuid}`;
}

/**
 * Builds the Forge Storage key for a repository-scoped config override.
 * Repository-level overrides take priority over project-level config.
 *
 * Repo-level overrides are designed for future use — admins can set them
 * via the Forge CLI (`forge storage set`) or direct Storage API calls.
 * A repository-level settings UI may be added later.
 */
function repoKey(repoUuid: string): string {
  return `dispatch-config-repo-${repoUuid}`;
}

/**
 * Retrieves the current app configuration from Forge Storage.
 *
 * Resolution order (first match wins):
 *   1. Repository-scoped config (if repoUuid is supplied)
 *   2. Project-scoped config (if projectUuid is supplied)
 *   3. Legacy global config (migration fallback)
 *   4. DEFAULT_CONFIG
 *
 * Missing fields are always backfilled from DEFAULT_CONFIG so callers
 * receive a fully-populated object.
 */
export async function getSettings(
  projectUuid?: string,
  repoUuid?: string,
): Promise<AppConfig> {
  // 1. Try repo-level override first (future-proofing).
  if (repoUuid) {
    const repoConfig = (await kvs.get<AppConfig>(repoKey(repoUuid))) as AppConfig | undefined;
    if (repoConfig) {
      return { ...DEFAULT_CONFIG, ...repoConfig };
    }
  }

  // 2. Try project-level config.
  if (projectUuid) {
    const projConfig = (await kvs.get<AppConfig>(projectKey(projectUuid))) as AppConfig | undefined;
    if (projConfig) {
      return { ...DEFAULT_CONFIG, ...projConfig };
    }
  }

  // 3. Fall back to legacy global config (migration path).
  const stored = (await kvs.get<AppConfig>(LEGACY_STORAGE_KEY)) as AppConfig | undefined;
  if (!stored) {
    return { ...DEFAULT_CONFIG };
  }
  return { ...DEFAULT_CONFIG, ...stored };
}

/**
 * Persists a (partial) app configuration to Forge Storage, scoped to the
 * provided project UUID.  If no projectUuid is given (e.g. during migration),
 * the legacy global key is used.
 *
 * The supplied values are merged on top of the existing persisted values.
 */
export async function saveSettings(
  config: Partial<AppConfig>,
  projectUuid?: string,
): Promise<void> {
  const current = await getSettings(projectUuid);
  const updated: AppConfig = { ...current, ...config };

  if (projectUuid) {
    await kvs.set(projectKey(projectUuid), updated);
  } else {
    // Legacy path (no project context available).
    await kvs.set(LEGACY_STORAGE_KEY, updated);
  }
}
