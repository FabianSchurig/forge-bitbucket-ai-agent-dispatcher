/**
 * Provider Factory (Factory Method Pattern).
 *
 * Returns the correct CIProvider implementation based on the project-scoped
 * configuration stored in Forge Storage.
 *
 * Adding a new provider requires:
 *   1. A new class implementing CIProvider
 *   2. A new case in the switch statement below
 *   3. Egress declarations in manifest.yml (if the provider is external)
 */

import { storage } from '@forge/api';
import type { CIProvider } from '../interfaces/CIProvider';
import { CIProviderError } from '../interfaces/CIProviderError';
import { BitbucketPipelinesProvider } from '../providers/BitbucketPipelinesProvider';
import { JenkinsProvider } from '../providers/JenkinsProvider';
import { getSettings } from '../storage';

/** Forge Storage key for the Jenkins API token (encrypted). */
const JENKINS_TOKEN_KEY = 'jenkins-api-token';

export class ProviderFactory {
  /**
   * Reads the project-scoped configuration and returns the appropriate
   * CIProvider instance, ready to use.
   *
   * Resolution order for configuration (handled by getSettings):
   *   1. Repository-scoped config override (if repoUuid supplied)
   *   2. Project-scoped config
   *   3. Legacy global config (migration fallback)
   *   4. DEFAULT_CONFIG
   *
   * Secret credentials (e.g. Jenkins token) are retrieved from Forge
   * Encrypted Storage — they are never stored in plain storage.
   *
   * @param projectUuid - Bitbucket project UUID for config lookup.
   * @param repoUuid    - Optional repo UUID for per-repo overrides.
   */
  static async getProvider(projectUuid?: string, repoUuid?: string): Promise<CIProvider> {
    const config = await getSettings(projectUuid, repoUuid);

    switch (config.ciType) {
      case 'BITBUCKET_PIPELINES':
        return new BitbucketPipelinesProvider(config);

      case 'JENKINS': {
        // The token is provisioned outside the settings UI (for example via
        // Forge CLI or other admin tooling) and read here with getSecret().
        const jenkinsToken = await storage.getSecret(JENKINS_TOKEN_KEY);

        if (!jenkinsToken) {
          throw new CIProviderError(
            'Jenkins',
            'No API token configured. Please configure the Jenkins API token via Forge CLI or other admin tooling.',
          );
        }

        if (!config.jenkinsUrl) {
          throw new CIProviderError(
            'Jenkins',
            'No Jenkins URL configured. Please set the Jenkins URL in the project settings.',
          );
        }

        if (!config.jenkinsJobPath) {
          throw new CIProviderError(
            'Jenkins',
            'No Jenkins job path configured. Please set the Jenkins job path in the project settings.',
          );
        }

        return new JenkinsProvider(config, jenkinsToken as string);
      }

      default:
        throw new CIProviderError(
          'Unknown',
          `Unsupported CI provider type: ${config.ciType as string}`,
        );
    }
  }
}
