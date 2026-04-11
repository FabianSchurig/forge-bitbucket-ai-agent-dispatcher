/**
 * Provider Factory (Factory Method Pattern).
 *
 * Returns the correct CIProvider implementation based on the workspace
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
   * Reads the workspace configuration and returns the appropriate
   * CIProvider instance, ready to use.
   *
   * Secret credentials (e.g. Jenkins token) are retrieved from Forge
   * Encrypted Storage — they are never stored in plain storage.
   */
  static async getProvider(): Promise<CIProvider> {
    const config = await getSettings();

    switch (config.ciType) {
      case 'BITBUCKET_PIPELINES':
        return new BitbucketPipelinesProvider(config);

      case 'JENKINS': {
        // Retrieve the Jenkins API token from Forge Encrypted Storage.
        // The token is stored via the settings UI using storage.setSecret().
        const jenkinsToken = await storage.getSecret(JENKINS_TOKEN_KEY);

        if (!jenkinsToken) {
          throw new CIProviderError(
            'Jenkins',
            'No API token configured. Please add a Jenkins API token in the workspace settings.',
          );
        }

        if (!config.jenkinsUrl) {
          throw new CIProviderError(
            'Jenkins',
            'No Jenkins URL configured. Please set the Jenkins URL in the workspace settings.',
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
