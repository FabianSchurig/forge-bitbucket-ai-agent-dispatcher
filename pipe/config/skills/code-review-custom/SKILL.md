---
name: code-review-custom
description: Review a Bitbucket pull request along two axes, standards and spec, and report each finding as an inline comment on the changed line. Use when asked to review a pull request, review a diff, or check changes against coding standards.
license: Apache-2.0
---

# Dual-axis pull request review

Review the pull request named in the prompt along two independent axes and
report every finding on the line it is about.

## Execution constraints

You are the only agent in this run. Do not spawn sub-agents, do not delegate,
and do not invoke another review skill. There is no orchestrator above you to
catch a loop, and the container is torn down when you exit.

Read-only against the source repository. The working tree is checked out at the
pull request's source branch, but nothing that survives this run is written from
it — the only durable output is what you report.

## Gathering the change

Nothing has been pre-fetched. Use the Bitbucket MCP tools, in this order:

1. `getAPullRequest` — title, description, source and destination branches.
2. `listChangesInAPullRequest` — which files changed and how.
3. `getThePatchForAPullRequest` — the actual diff.
4. `listCommentsOnAPullRequest` — what reviewers have already said. Do not
   repeat a point someone has already made on the same line.

If the patch is too large to reason about whole, rank files by churn and review
the largest few against the working tree on disk.

## Axis 1 — Standards

Compare the diff against, in order of precedence:

1. The repository's own standards file, if one exists (`CODING_STANDARDS.md`,
   `CONTRIBUTING.md`, or a `.clang-format` / linter config that encodes a rule
   the diff breaks).
2. The vocabulary in the repository's `CONTEXT.md`. Flag any new identifier that
   contradicts an established term or reintroduces one listed under `_Avoid_`.
3. Fowler's code smells as a general baseline — long method, large class,
   feature envy, primitive obsession, shotgun surgery, and the rest.
4. Correctness: undefined behaviour, resource leaks, unchecked errors,
   off-by-one, races. These outrank style.

## Axis 2 — Spec

Compare the diff against what was actually asked for. The requirement lives in
the pull request description, in a linked issue, or under `docs/`. State plainly
when you cannot find a requirement to check against — an unverifiable spec axis
is a finding in itself, not something to paper over.

Look for scope that exceeds the requirement as carefully as scope that falls
short of it.

## Anchoring findings

Every finding that is about specific code is anchored to **one line that the
pull request adds or changes**, identified by its path and its line number in
the *new* version of the file. Read the number off the diff hunk headers
(`@@ -a,b +c,d @@`): count `+` and context lines from `c`. Never anchor to a
line the diff does not touch — Bitbucket will reject or misplace it.

Findings that are not about one line (a missing requirement, an overall design
concern) go in the summary only.

Severity is one of `blocker`, `major`, `minor`, `nit`. Report most-severe first.
Keep each finding to what is wrong, why it matters, and what to do instead —
two to four sentences. Do not restate the diff. Do not praise.

## Reporting

The prompt tells you whether this run is **read-only**.

### Normal run

1. For each anchored finding, post one inline comment with
   `createACommentOnAPullRequest`, setting `inline.path` to the file path and
   `inline.to` to the new-file line. Start the body with the severity in bold,
   e.g. `**major** — …`.
2. Then post exactly one summary comment (no `inline`): two sections, one per
   axis, each a short list of findings with `path:line` references, plus any
   un-anchored findings. Say so explicitly when an axis has no findings.

If the change is clean on both axes, a single two-line summary comment saying
exactly that is the correct output.

### Read-only run

Bitbucket write operations are unavailable. Do not attempt to post anything.
Print your findings to standard output, exactly in this form and nothing else
between the markers:

```
AI-AGENT-FINDINGS-BEGIN
{"path": "src/foo.cpp", "line": 42, "severity": "major", "axis": "standards", "body": "…"}
{"path": "src/bar.h", "line": 7, "severity": "nit", "axis": "spec", "body": "…"}
{"summary": "…the summary comment you would have posted, markdown allowed…"}
AI-AGENT-FINDINGS-END
```

One JSON object per line. `line` is the new-file line, as above. The last
object is always the summary.
