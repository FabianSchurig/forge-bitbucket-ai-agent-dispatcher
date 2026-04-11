/**
 * CI/CD Provider Contract (Strategy Pattern Interface).
 *
 * Every CI/CD integration (Bitbucket Pipelines, Jenkins, GitHub Actions, etc.)
 * must implement this interface.  The dispatcher and resolver code only ever
 * interact with a CIProvider — they never know which concrete provider is
 * doing the actual work.
 *
 * Adding a new provider is a three-step process:
 *   1. Create a class that implements CIProvider
 *   2. Register it in the ProviderFactory switch statement
 *   3. Declare any new egress domains in manifest.yml
 */

import { DispatchContext } from '../types';

// ---------------------------------------------------------------------------
// Supported CI provider type identifiers.
// Used in AppConfig.ciType and ProviderFactory to route to the right class.
// ---------------------------------------------------------------------------

/** Discriminated union of all supported CI provider identifiers. */
export type CIProviderType = 'BITBUCKET_PIPELINES' | 'JENKINS';

// ---------------------------------------------------------------------------
// Payload & result types shared across all providers.
// ---------------------------------------------------------------------------

/**
 * Generic build payload sent to every CI provider.
 * Contains all the contextual data a provider needs to start a build.
 */
export interface BuildPayload {
  /** Git branch to build from. */
  branch: string;
  /** Repository identifier (slug or UUID) where the event originated. */
  repoName: string;
  /** Workspace identifier where the event originated. */
  workspace: string;
  /** Pull-request ID (0 if not applicable). */
  prId: number;
  /** Full text of the triggering comment. */
  commentText: string;
  /** Atlassian account ID of the user who triggered the build. */
  commentAuthor: string;
  /** ID of the triggering comment (used by providers that avoid sending
   *  large text in URLs — e.g. Jenkins passes only the ID so the CI job
   *  can fetch comment content server-side). */
  commentId: number;
}

/**
 * Standardised result returned by triggerBuild().
 * Providers map their API-specific responses into this shape so
 * the caller never needs to understand provider internals.
 */
export interface BuildResult {
  /** Whether the build was successfully triggered. */
  success: boolean;
  /** Human-readable status message. */
  message: string;
  /** Optional provider-specific build identifier for later status checks. */
  buildId?: string;
}

// ---------------------------------------------------------------------------
// The CIProvider interface (Strategy Pattern contract).
// ---------------------------------------------------------------------------

/**
 * Every CI/CD provider must implement these two methods.
 * The dispatcher calls triggerBuild(); the UI can optionally
 * call getBuildStatus() to poll for progress.
 */
export interface CIProvider {
  /** Triggers a new build in the target CI environment. */
  triggerBuild(payload: BuildPayload, context: DispatchContext): Promise<BuildResult>;

  /** Checks the status of an ongoing build by its provider-specific ID. */
  getBuildStatus(buildId: string): Promise<string>;
}
