/**
 * Jenkins CI Provider.
 *
 * Implements the CIProvider interface for Jenkins.
 * Triggers a parameterised build via Jenkins' Remote Build Trigger REST API
 * using Forge's fetch API for outbound HTTP calls.
 *
 * IMPORTANT:
 *   - The Jenkins base URL must be declared in manifest.yml
 *     (permissions.external.fetch.backend) or Forge will block the request.
 *   - The Jenkins API token must be stored using Forge Encrypted Storage
 *     (storage.setSecret).  This provider receives the token via its
 *     constructor — the ProviderFactory is responsible for retrieving it.
 */

import api from '@forge/api';
import type { CIProvider, BuildPayload, BuildResult } from '../interfaces/CIProvider';
import { CIProviderError } from '../interfaces/CIProviderError';
import type { AppConfig, DispatchContext } from '../types';

export class JenkinsProvider implements CIProvider {
  private readonly jenkinsUrl: string;
  private readonly jenkinsJobPath: string;
  private readonly apiToken: string;

  /**
   * @param config - The full AppConfig (jenkinsUrl and jenkinsJobPath are read).
   * @param apiToken - Jenkins API token retrieved from Forge Encrypted Storage.
   */
  constructor(config: AppConfig, apiToken: string) {
    this.jenkinsUrl = config.jenkinsUrl.replace(/\/+$/, ''); // strip trailing slashes
    this.jenkinsJobPath = config.jenkinsJobPath;
    this.apiToken = apiToken;
  }

  // -----------------------------------------------------------------------
  // CIProvider.triggerBuild
  // -----------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async triggerBuild(payload: BuildPayload, _context: DispatchContext): Promise<BuildResult> {
    // Build the Jenkins "buildWithParameters" URL.
    // Jenkins expects query-string parameters for a parameterised build.
    const params = new URLSearchParams({
      SOURCE_WORKSPACE: payload.workspace,
      SOURCE_REPO: payload.repoName,
      PR_ID: String(payload.prId),
      SOURCE_BRANCH: payload.branch,
      COMMENT_TEXT: payload.commentText,
      COMMENT_AUTHOR: payload.commentAuthor,
    });

    const url = `${this.jenkinsUrl}/${this.jenkinsJobPath}/buildWithParameters?${params.toString()}`;

    try {
      // Forge external fetch — the domain must be declared in manifest.yml.
      const response = await api.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${this.apiToken}`,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new CIProviderError(
          'Jenkins',
          `Failed to trigger build: ${response.status} – ${body}`,
          response.status,
        );
      }

      // Jenkins returns 201 on success with a Location header pointing at the
      // queue item.  We extract the queue item ID as a pseudo-buildId.
      const location = response.headers.get('Location') ?? '';
      const queueId = location.match(/\/queue\/item\/(\d+)/)?.[1] ?? '';

      return {
        success: true,
        message: `Jenkins build triggered for ${payload.repoName}.`,
        buildId: queueId || undefined,
      };
    } catch (error) {
      if (error instanceof CIProviderError) {
        throw error;
      }
      throw new CIProviderError(
        'Jenkins',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // -----------------------------------------------------------------------
  // CIProvider.getBuildStatus
  // -----------------------------------------------------------------------

  async getBuildStatus(buildId: string): Promise<string> {
    // Jenkins queue items eventually resolve to an executable build.
    // We first check the queue item, then the build itself.
    const url = `${this.jenkinsUrl}/queue/item/${buildId}/api/json`;

    try {
      const response = await api.fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${this.apiToken}`,
        },
      });

      if (!response.ok) {
        throw new CIProviderError(
          'Jenkins',
          `Failed to fetch build status: ${response.status}`,
          response.status,
        );
      }

      const data = (await response.json()) as Record<string, unknown>;

      // If the queue item has been executed, the "executable" field is present.
      const executable = data?.executable as Record<string, unknown> | undefined;
      if (executable) {
        return (executable.result as string) ?? 'IN_PROGRESS';
      }

      // Still in the queue.
      return 'QUEUED';
    } catch (error) {
      if (error instanceof CIProviderError) {
        throw error;
      }
      throw new CIProviderError(
        'Jenkins',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
