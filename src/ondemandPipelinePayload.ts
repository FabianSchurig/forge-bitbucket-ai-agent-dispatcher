/**
 * Shared helper for constructing the Bitbucket on-demand pipelines API
 * request: the YAML body and the query string carrying target selection
 * + variables.
 *
 * The on-demand pipelines API (announced 2026-04-22) replaces the static
 * `bitbucket-pipelines.yml` lookup with a runtime YAML body.  Target
 * selection (branch/commit) and pipeline variables move from the JSON
 * body into URL query parameters.
 *
 * Endpoint: POST /2.0/repositories/{ws}/{repo}/pipelines/
 * Headers : Content-Type: application/yaml
 * Query   : target.type=pipeline_ref_target&target.ref_type=branch&
 *           target.ref_name=<branch>&variables[0].key=SOURCE_WORKSPACE&
 *           variables[0].value=<ws>&… (one indexed pair per variable)
 *
 * See the Atlassian docs:
 *   https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/
 */

import type { AppConfig, DispatchContext } from './types';
import { CIProviderError } from './interfaces/CIProviderError';

/** Result of building the on-demand request. */
export interface OndemandRequest {
  /** Owning workspace slug used to construct the API path. */
  targetWorkspace: string;
  /** Repository slug used to construct the API path. */
  targetRepoSlug: string;
  /** Validated branch name used for `target.ref_name`. */
  targetBranch: string;
  /** YAML body to POST as the request body (Content-Type: application/yaml). */
  yamlBody: string;
  /**
   * URLSearchParams carrying the target selection and pipeline variables.
  * The Forge `route` tag accepts a URLSearchParams substitution natively,
  * so callers can embed it directly with `route\`/.../pipelines?${queryParams}\``
  * without duplicating the encoding logic.
   */
  queryParams: URLSearchParams;
}

/**
 * Strict allowlist for Bitbucket workspace/repo slugs.
 * Bitbucket slugs are lowercase alphanumeric with '-', '_', '.'.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Allowlist for git branch names.  Allows the chars Bitbucket actually
 * accepts in refs (alphanumerics, '/', '-', '_', '.') but rejects the
 * obvious URL-injection vectors ('?', '&', '#', whitespace, etc).
 */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Parses an "ondemandTargetRepo" config value of the form "{ws}/{repo}"
 * into its two parts and validates each slug against the strict allowlist.
 * Throws CIProviderError on invalid input.
 *
 * Exported so other modules (e.g. BitbucketOndemandProvider.getBuildStatus)
 * can reuse the same parsing + validation rules and keep error messages
 * consistent across all on-demand code paths.
 */
export function parseTargetRepo(raw: string): { workspace: string; repoSlug: string } {
  const parts = raw.split('/').filter((p) => p.length > 0);
  if (parts.length !== 2) {
    throw new CIProviderError(
      'Bitbucket Pipelines (on-demand)',
      `Invalid target repository "${raw}". Expected format: "workspace/repo".`,
    );
  }
  const [workspace, repoSlug] = parts;
  if (!SLUG_RE.test(workspace) || !SLUG_RE.test(repoSlug)) {
    throw new CIProviderError(
      'Bitbucket Pipelines (on-demand)',
      `Invalid target repository slug in "${raw}". Slugs must be alphanumeric and may contain '-', '_', '.'.`,
    );
  }
  return { workspace, repoSlug };
}

/**
 * Validates a branch name against the strict allowlist.
 * Throws CIProviderError if the value is unsafe to splice into the URL.
 */
function validateBranch(branch: string): void {
  if (!branch || !BRANCH_RE.test(branch)) {
    throw new CIProviderError(
      'Bitbucket Pipelines (on-demand)',
      `Invalid target branch "${branch}". Branch names must start with an alphanumeric and may contain '-', '_', '.', '/'.`,
    );
  }
}

/**
 * Allowlist for admin-defined pipeline variable keys.
 * Matches POSIX environment variable grammar: starts with a letter or '_',
 * followed by letters, digits, or '_'.  This is also what Bitbucket allows
 * for pipeline `variables[].name` entries.
 */
const VARIABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates an admin-defined variable key.  Throws CIProviderError when
 * the value is unsafe to splice into the URL or would be rejected by
 * Bitbucket's pipeline runner.
 */
function validateVariableKey(key: string): void {
  if (!VARIABLE_KEY_RE.test(key)) {
    throw new CIProviderError(
      'Bitbucket Pipelines (on-demand)',
      `Invalid pipeline variable name "${key}". Names must start with a letter or underscore and contain only letters, digits, and underscores.`,
    );
  }
}

/**
 * Validates a workspace/repo slug against the strict allowlist.
 * Throws CIProviderError when the slug is unsafe to splice into the URL.
 *
 * The fallback path uses the spoke workspace/repo slugs returned by
 * fetchRepositoryDetails(); validating them defends against malformed or
 * malicious data flowing in via the Bitbucket API response.
 */
function validateSlug(slug: string, label: string): void {
  if (!slug || !SLUG_RE.test(slug)) {
    throw new CIProviderError(
      'Bitbucket Pipelines (on-demand)',
      `Invalid ${label} "${slug}".`,
    );
  }
}

/**
 * Builds the full on-demand pipelines request: target repo + YAML body +
 * query string.
 *
 * Resolution rules:
 *   - targetRepo:   config override → spoke workspace/repo from the payload
 *   - targetBranch: config override → PR source branch from the payload
 *
 * The YAML template is sent verbatim — variables are NOT substituted into
 * the YAML.  Bitbucket exposes the query-parameter variables as ordinary
 * environment variables inside the running steps, where they can be
 * referenced as $SOURCE_WORKSPACE etc.
 */
export function buildOndemandRequest(
  context: DispatchContext,
  config: AppConfig,
): OndemandRequest {
  // --- Resolve target repository ----------------------------------------
  let targetWorkspace: string;
  let targetRepoSlug: string;

  if (config.ondemandTargetRepo && config.ondemandTargetRepo.trim().length > 0) {
    const parsed = parseTargetRepo(config.ondemandTargetRepo.trim());
    targetWorkspace = parsed.workspace;
    targetRepoSlug = parsed.repoSlug;
  } else {
    targetWorkspace = context.workspace;
    targetRepoSlug = context.repoSlug;
    validateSlug(targetWorkspace, 'workspace slug');
    validateSlug(targetRepoSlug, 'repository slug');
  }

  // --- Resolve target branch --------------------------------------------
  const targetBranch =
    config.ondemandTargetBranch && config.ondemandTargetBranch.trim().length > 0
      ? config.ondemandTargetBranch.trim()
      : context.sourceBranch;
  validateBranch(targetBranch);

  // --- Build query string -----------------------------------------------
  // URLSearchParams handles all the percent-encoding so values containing
  // spaces / Unicode / reserved characters are safe.
  const params = new URLSearchParams();
  params.append('target.type', 'pipeline_ref_target');
  params.append('target.ref_type', 'branch');
  params.append('target.ref_name', targetBranch);

  // Bitbucket models pipeline variables as an array in the JSON API, so the
  // on-demand YAML endpoint expects indexed JSON-path query parameters.
  const variables: Array<[string, string]> = [
    ['SOURCE_WORKSPACE', context.workspace],
    ['SOURCE_REPO', context.repoSlug],
    ['PR_ID', String(context.prId)],
    ['SOURCE_BRANCH', context.sourceBranch],
    ['COMMENT_TEXT', context.commentText],
    ['COMMENT_AUTHOR', context.commentAuthor],
  ];

  variables.forEach(([key, value], index) => {
    params.append(`variables[${index}].key`, key);
    params.append(`variables[${index}].value`, value);
  });

  // -- Admin-defined extra variables -------------------------------------
  // These continue the same `variables[N].*` indexed sequence so Bitbucket
  // sees one flat array of variables.  Empty-key rows are skipped (the
  // settings UI may produce blank placeholder rows) and the secured flag
  // is only emitted when true to keep URLs tidy.  Keys are validated
  // against the standard env-var grammar to reject anything that could
  // confuse the pipeline runner.
  let nextIndex = variables.length;
  for (const variable of config.pipelineVariables ?? []) {
    const key = (variable.key ?? '').trim();
    if (!key) {
      continue;
    }
    validateVariableKey(key);
    params.append(`variables[${nextIndex}].key`, key);
    params.append(`variables[${nextIndex}].value`, variable.value ?? '');
    if (variable.secured) {
      params.append(`variables[${nextIndex}].secured`, 'true');
    }
    nextIndex += 1;
  }

  return {
    targetWorkspace,
    targetRepoSlug,
    targetBranch,
    yamlBody: config.ondemandYamlTemplate,
    queryParams: params,
  };
}
