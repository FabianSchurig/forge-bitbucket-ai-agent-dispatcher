---
name: code-review-custom
description: Review a Bitbucket pull request along two axes, standards and spec. Use when asked to review a pull request, review a diff, or check changes against coding standards.
license: Apache-2.0
---

# Dual-axis pull request review

Review the pull request named in the prompt along two independent axes and
report both.

## Execution constraints

You are the only agent in this run. Do not spawn sub-agents, do not delegate,
and do not invoke another review skill. There is no orchestrator above you to
catch a loop, and the container is torn down when you exit.

Read-only against the source repository. The working tree is checked out at the
pull request's source branch, but nothing that survives this run is written from
it — the only durable output is the comment you post.

## Gathering the change

Nothing has been pre-fetched. Use the Bitbucket MCP tools, in this order:

1. `getAPullRequest` — title, description, source and destination branches.
2. `listChangesInAPullRequest` — which files changed and how.
3. `getThePatchForAPullRequest` — the actual diff.

If the patch is too large to reason about whole, fall back to
`compareTwoCommitDiffStats` to rank files by churn and review the largest few
against the working tree on disk.

## Axis 1 — Standards

Compare the diff against, in order of precedence:

1. The repository's own standards file, if one exists (`CODING_STANDARDS.md`,
   `CONTRIBUTING.md`, or a `.clang-format` / linter config that encodes a rule
   the diff breaks).
2. The vocabulary in the repository's `CONTEXT.md`. Flag any new identifier that
   contradicts an established term or reintroduces one listed under `_Avoid_`.
3. Fowler's code smells as a general baseline — long method, large class,
   feature envy, primitive obsession, shotgun surgery, and the rest.

Prefer the repository's own architectural vocabulary over generic terms. If the
repository ships a `codebase-design` skill, use its language: module, interface,
depth, seam, adapter, leverage, locality.

## Axis 2 — Spec

Compare the diff against what was actually asked for. The requirement lives in
the pull request description, in a linked issue, or under `docs/`. State plainly
when you cannot find a requirement to check against — an unverifiable spec axis
is a finding in itself, not something to paper over.

Look for scope that exceeds the requirement as carefully as scope that falls
short of it.

## Reporting

Post one comment with `createACommentOnAPullRequest`. Structure it as two
sections, one per axis, each listing findings most-severe first with a file and
line reference. Say so explicitly when an axis has no findings.

Do not restate the diff. Do not praise. If the change is clean on both axes, a
two-line comment saying exactly that is the correct output.
