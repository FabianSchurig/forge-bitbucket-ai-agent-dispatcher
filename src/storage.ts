import kvs from '@forge/kvs';
import { AppConfig, DEFAULT_CONFIG, PipelineVariable } from './types';

/**
 * Legacy global storage key used before the project-scoped migration.
 * Kept only for one-time fallback reads during migration.
 */
const LEGACY_STORAGE_KEY = 'appConfig';

/**
 * Strips the curly-brace wrapper that Bitbucket wraps all UUIDs in
 * (e.g. "{abc-123}" → "abc-123") so the result can be used safely as a
 * Forge KVS storage key.
 *
 * The KVS key pattern only allows [a-zA-Z0-9:._\s-#] — curly braces are
 * NOT permitted and will cause a ForgeKvsAPIError at runtime.
 */
function sanitizeUuid(uuid: string): string {
  return uuid.replace(/[{}]/g, '');
}

/**
 * Builds the Forge Storage key for a project-scoped config.
 * All configuration is namespaced by the Bitbucket project UUID so
 * different projects in the same workspace can use different CI backends.
 */
function projectKey(projectUuid: string): string {
  return `dispatch-config-${sanitizeUuid(projectUuid)}`;
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
  return `dispatch-config-repo-${sanitizeUuid(repoUuid)}`;
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
 *
 * Special handling for `pipelineVariables`:
 *   - Rows with an empty `key` are dropped (UI may submit blank "new row"
 *     placeholders).
 *   - For secured rows whose `value` is empty, the existing stored value
 *     for that key (if any) is preserved.  This implements the write-only
 *     UX where the settings page never echoes secured values back, but a
 *     user can still re-save the form without clobbering existing secrets.
 */
export async function saveSettings(
  config: Partial<AppConfig>,
  projectUuid?: string,
): Promise<void> {
  const current = await getSettings(projectUuid);
  const merged: AppConfig = { ...current, ...config };

  // Reconcile pipelineVariables if the caller supplied them.
  if (config.pipelineVariables !== undefined) {
    merged.pipelineVariables = mergePipelineVariables(
      current.pipelineVariables ?? [],
      config.pipelineVariables,
    );
  }

  if (projectUuid) {
    await kvs.set(projectKey(projectUuid), merged);
  } else {
    // Legacy path (no project context available).
    await kvs.set(LEGACY_STORAGE_KEY, merged);
  }
}

/**
 * Returns the app configuration with all secured variable values stripped.
 * Use this in any code path that returns config to the settings UI so that
 * secured values never leave the backend after they're first stored.
 */
export async function getSettingsForUi(
  projectUuid?: string,
  repoUuid?: string,
): Promise<AppConfig> {
  const config = await getSettings(projectUuid, repoUuid);
  return {
    ...config,
    pipelineVariables: (config.pipelineVariables ?? []).map((v) =>
      v.secured ? { ...v, value: '' } : v,
    ),
  };
}

/**
 * Merges incoming pipeline variables on top of the previously-stored list.
 *
 * Rules:
 *   - Empty-key rows are dropped (treated as blank "new row" placeholders).
 *   - Secured rows with an empty value inherit the previously-stored value
 *     for the same key (preserves write-only secrets through a no-op save).
 *   - Non-secured rows are taken verbatim from the incoming list.
 */
function mergePipelineVariables(
  previous: PipelineVariable[],
  incoming: PipelineVariable[],
): PipelineVariable[] {
  const previousByKey = new Map(previous.map((v) => [v.key, v]));
  return incoming
    .filter((v) => v.key && v.key.trim().length > 0)
    .map((v) => {
      if (v.secured && v.value === '') {
        const prior = previousByKey.get(v.key);
        if (prior && prior.secured) {
          return { ...v, value: prior.value };
        }
      }
      return v;
    });
}
