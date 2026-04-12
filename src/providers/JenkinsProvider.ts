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

/**
 * Wraps an unknown caught error into a CIProviderError.
 *
 * REQUEST_EGRESS_ALLOWLIST_ERR is thrown by the Forge network proxy when the
 * Jenkins domain has not been approved via Customer-Managed Egress or a
 * workspace admin has since revoked the approval.  The error is given a clear,
 * actionable message so the PR failure comment explains what needs to be done.
 *
 * All other errors are wrapped with their original message preserved.
 */
function wrapJenkinsError(error: unknown): CIProviderError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('REQUEST_EGRESS_ALLOWLIST_ERR')) {
    return new CIProviderError(
      'Jenkins',
      'Jenkins domain is not in the approved egress allowlist. ' +
      'Ask your workspace admin to re-authorize the Jenkins URL in the app settings.',
    );
  }
  return new CIProviderError('Jenkins', message);
}

export class JenkinsProvider implements CIProvider {
  private readonly jenkinsUrl: string;
  private readonly jenkinsJobPath: string;
  private readonly apiToken: string;

  /**
   * @param config - The full AppConfig (jenkinsUrl and jenkinsJobPath are read).
   * @param apiToken - Base64-encoded "username:token" string for Jenkins Basic auth,
   *                   retrieved from Forge Encrypted Storage.
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
    //
    // Security: COMMENT_TEXT is intentionally excluded from the URL parameters.
    // Comment text can be large and may contain sensitive information; placing
    // it in the URL risks exposure in proxy/access logs and may exceed URL
    // length limits.  Instead we pass only stable identifiers (COMMENT_ID)
    // so the CI job can fetch the full comment text server-side if needed.
    const params = new URLSearchParams({
      SOURCE_WORKSPACE: payload.workspace,
      SOURCE_REPO: payload.repoName,
      PR_ID: String(payload.prId),
      SOURCE_BRANCH: payload.branch,
      COMMENT_ID: String(payload.commentId),
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

      // Construct a user-visible URL for the Jenkins build.
      // At trigger-time we only have the queue item, not the final build URL.
      // We link to the job page which is the best stable reference.
      const buildUrl = `${this.jenkinsUrl}/${this.jenkinsJobPath}`;

      return {
        success: true,
        message: `Jenkins build triggered for ${payload.repoName}.`,
        buildId: queueId || undefined,
        buildUrl,
      };
    } catch (error) {
      if (error instanceof CIProviderError) {
        throw error;
      }
      throw wrapJenkinsError(error);
    }
  }

  // -----------------------------------------------------------------------
  // CIProvider.getBuildStatus
  // -----------------------------------------------------------------------

  async getBuildStatus(buildId: string): Promise<string> {
    // Jenkins queue items eventually resolve to an executable build.
    // Step 1: Check the queue item for an executable reference.
    const queueUrl = `${this.jenkinsUrl}/queue/item/${buildId}/api/json`;

    try {
      const queueResponse = await api.fetch(queueUrl, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${this.apiToken}`,
        },
      });

      if (!queueResponse.ok) {
        throw new CIProviderError(
          'Jenkins',
          `Failed to fetch queue item status: ${queueResponse.status}`,
          queueResponse.status,
        );
      }

      const data = (await queueResponse.json()) as Record<string, unknown>;

      // If the queue item has not been executed yet, it stays "QUEUED".
      const executable = data?.executable as Record<string, unknown> | undefined;
      if (!executable) {
        return 'QUEUED';
      }

      // Step 2: The queue item has an executable — fetch the actual build to
      // get the real status.  Queue items typically don't include the build
      // result; that lives on the build endpoint.
      const executableUrl = typeof executable.url === 'string' ? executable.url : '';
      if (!executableUrl || !/^https?:\/\//i.test(executableUrl)) {
        // No valid URL — the build is likely still being allocated.
        return 'IN_PROGRESS';
      }

      const buildStatusUrl = `${executableUrl.replace(/\/+$/, '')}/api/json`;
      const buildResponse = await api.fetch(buildStatusUrl, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${this.apiToken}`,
        },
      });

      if (!buildResponse.ok) {
        throw new CIProviderError(
          'Jenkins',
          `Failed to fetch executable build status: ${buildResponse.status}`,
          buildResponse.status,
        );
      }

      const buildData = (await buildResponse.json()) as Record<string, unknown>;

      // If the build is still running, result will be null.
      if (buildData.building === true) {
        return 'IN_PROGRESS';
      }

      return typeof buildData.result === 'string' ? buildData.result : 'IN_PROGRESS';
    } catch (error) {
      if (error instanceof CIProviderError) {
        throw error;
      }
      throw wrapJenkinsError(error);
    }
  }
}
