# Jenkins builds the base image; the pipe image supplies only profile and scripts

ADR 0001 rules out executing the pipe image on Jenkins, which raises the
question of what — if anything — the two runtimes still share. Sharing nothing
means every change to how the agent is provisioned has to be made twice, in two
repositories, and will eventually be made only once.

The split is: **Jenkins owns producing an image; the pipe repo owns what the
agent does inside it.**

Jenkins checks out the source repository and builds its devcontainer into a
**base image**, using an explicit `--config` and the same registry cache the
repository's own build job uses. The pipe repo owns `provision.sh` (OS packages,
bb-mcp, lifecycle replay, baseline skills) and `execute.sh` (secret handling,
MCP config rendering, agent invocation), plus the agent profiles those scripts
read. Jenkins pulls both out of the published pipe image with `COPY --from` and
calls them from a thin Dockerfile held in the Jenkins shared library as a
`libraryResource`.

The alternative was for the shared library to hold its own copy of the runner
Dockerfile. That was rejected because the runner Dockerfile was, until this
change, a heredoc generated at runtime inside `run-agent.sh` — so a copy would
have been a second implementation from day one, with no mechanism to notice
drift. Extracting the heredoc into real scripts was the price of having one.

Two consequences worth knowing:

The `libraryResource` Dockerfile must stay thin. Any behaviour that leaks into
it is behaviour that only exists on Jenkins. It should do nothing but `COPY
--from`, set the user, and call the two scripts.

The base image must be **pushed**, not loaded, whenever the buildx builder uses
the `docker-container` driver — that driver cannot resolve a `FROM` from the
local image store. Any pipeline that builds a devcontainer image and then uses
it as the base of a second buildx build has to push it for the same reason.
