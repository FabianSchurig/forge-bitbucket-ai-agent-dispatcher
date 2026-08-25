# The agent self-serves pull request context and nothing is extracted

The agent fetches the pull request, its description and its patch itself through
`bb-mcp`, and posts its result the same way. Jenkins pre-fetches no diff, and
the agent build runs with `load = false` — no image is kept, no artifact is
extracted, no file leaves the container.

This is worth recording because it is deliberately unlike a conventional build
job. A build pipeline normally takes its deliverables out of a
`FROM scratch AS export` stage and archives them, so a reader who knows that
pattern will assume the agent job simply forgot to.

The trade was simplicity against auditability. Pre-fetching would have meant
Jenkins fetching the base ref, computing `git diff BASE...HEAD`, running a
redaction pass, and archiving both the input and the report — a deterministic,
reviewable record of exactly what the agent saw and said. Self-serving means
none of that exists, but it also means no `fetch-pr-context` tool to build and
maintain, no base-ref parameter, and no dependence on clone depth. For a v1
whose purpose is to prove the orchestration, that won.

The costs are real and are accepted knowingly:

- **No audit trail.** For a codebase under a regulated change-control process
  this is the weakest point of the design, and the most likely reason to revisit
  this ADR.
- **Silent no-op.** If the agent never calls `createACommentOnAPullRequest`, the
  build is green and nothing happened.
- **`PR_ID` is effectively required.** Without one the agent has no diff to
  reason about, whatever the prompt says.
- **No redaction.** Whatever is in the diff reaches the model.

Reversing this is cheap on the Jenkins side and was kept that way: the agent
build names an explicit `target`, so adding a `FROM scratch AS export` stage and
switching `load` is a small, local change.
