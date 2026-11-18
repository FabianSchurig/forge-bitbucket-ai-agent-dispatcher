/**
 * Branch-name generation for the Jira issue-context dispatcher.
 *
 * A Jira issue summary is free-form, user-controlled text.  Before it can be
 * used as (part of) a git branch name it MUST be reduced to a small, known-safe
 * character set.  This is a security boundary as well as a cosmetic one: the
 * resulting branch name is spliced into Bitbucket REST URLs and exposed to
 * pipeline runners, so a summary such as `"; rm -rf * ;"` must never survive as
 * anything other than an inert slug.
 *
 * The functions here are pure (no Forge/network dependencies) so the slugging
 * rules can be exhaustively unit-tested.
 */

import { CIProviderError } from '../interfaces/CIProviderError';
import { BRANCH_RE } from '../ondemandPipelinePayload';

/** Provider label used in error messages raised from the Jira dispatch flow. */
const PROVIDER_NAME = 'Jira AI Agent Dispatch';

/**
 * Maximum length of the slugified summary portion of a branch name.  Keeping
 * the summary bounded avoids generating refs that bump into Bitbucket/git ref
 * length limits when an issue has a very long title.
 */
const MAX_SUMMARY_SLUG_LENGTH = 50;

/**
 * Converts arbitrary text into a lowercase, hyphen-separated slug containing
 * only `[a-z0-9-]`.
 *
 * Steps:
 *   1. Unicode-normalise and strip combining diacritical marks so accented
 *      characters fold to their ASCII base (e.g. "é" → "e").
 *   2. Lowercase.
 *   3. Replace every run of non-alphanumeric characters with a single hyphen —
 *      this is what neutralises shell/URL metacharacters.
 *   4. Trim leading/trailing hyphens.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Sanitises a Jira issue key (e.g. "PROJ-123") into the characters allowed in
 * a git ref while preserving its conventional upper-case form.  Anything that
 * is not an ASCII letter, digit, or hyphen is removed.
 */
function sanitizeIssueKey(issueKey: string): string {
  return issueKey.replace(/[^A-Za-z0-9-]+/g, '').replace(/^-+|-+$/g, '');
}

/**
 * Builds a safe git branch name from a Jira issue key and summary, of the form
 * `PROJ-123-short-slug-of-summary`.
 *
 * The summary slug is length-bounded.  When the summary yields no usable
 * characters the branch is just the sanitised issue key.  The final result is
 * validated against {@link BRANCH_RE} as a defence-in-depth check so callers
 * can rely on the return value being safe to use in a URL/ref.
 *
 * @throws CIProviderError when the issue key has no usable characters, or (as a
 *   safety net) if the assembled name somehow fails branch validation.
 */
export function buildBranchName(issueKey: string, summary: string): string {
  const keyPart = sanitizeIssueKey(issueKey);
  if (!keyPart) {
    throw new CIProviderError(
      PROVIDER_NAME,
      `Cannot derive a branch name from issue key "${issueKey}".`,
    );
  }

  const summarySlug = slugify(summary)
    .slice(0, MAX_SUMMARY_SLUG_LENGTH)
    .replace(/-+$/g, '');

  const branch = summarySlug ? `${keyPart}-${summarySlug}` : keyPart;

  // Defence in depth: the slugging rules above should already guarantee a safe
  // result, but validating here means any future change to those rules cannot
  // silently start emitting an unsafe ref.
  if (!BRANCH_RE.test(branch)) {
    throw new CIProviderError(
      PROVIDER_NAME,
      `Generated an invalid branch name "${branch}".`,
    );
  }

  return branch;
}

/**
 * Sanitises a user-edited branch name into a safe git ref while preserving its
 * case and structure (including `/` path separators).
 *
 * Used when the panel sends a branch the user typed/edited: we cannot trust it
 * to be safe, but unlike {@link buildBranchName} we must not prepend the issue
 * key or lowercase it — the user chose this value deliberately.  Unsafe
 * character runs collapse to a single hyphen and the result is validated.
 *
 * @throws CIProviderError when the input cannot be reduced to a valid ref.
 */
export function sanitizeBranch(input: string): string {
  const cleaned = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '');

  if (!cleaned || !BRANCH_RE.test(cleaned)) {
    throw new CIProviderError(
      PROVIDER_NAME,
      `Cannot derive a valid branch name from "${input}".`,
    );
  }

  return cleaned;
}
