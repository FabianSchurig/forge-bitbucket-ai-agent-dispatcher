# Jenkins executes the agent with `docker buildx build`, never `docker run`

On Bitbucket, `ai-agent-pipe` is executed as a container: `entrypoint.sh` runs,
clones the source repository, and shells out to `devcontainer build` and
`docker build` against a mounted Docker socket. The obvious way to reuse it from
Jenkins would be the same thing — `docker run -v /var/run/docker.sock`, which
`pipe/README.md` already documents for local debugging.

We do not do that. On Jenkins the agent runs as a `docker buildx build` whose
final stage invokes `execute.sh`.

The forcing constraint is that **the pipe image can never be executed inside a
BuildKit `RUN`**. A `RUN` mount takes its source from a build context or another
image, not from an arbitrary host path, and a Unix socket cannot be placed in a
build context. So a container that needs a Docker daemon cannot be nested inside
a build. If the Jenkins shared library driving the build is itself built around
buildx — which is where registry cache, `--mount=type=secret` and
`--no-cache-filter` live — the choice is between keeping the pipe's
orchestration and giving up buildx, or keeping buildx and giving up the pipe's
orchestration.

Buildx wins on secrets. Passing a token to `docker run` means either
`-e TOKEN=<value>`, which puts it in the build machine's `ps` output, or an
env-file that has to be written to disk and cleaned up. `--mount=type=secret`
needs neither: the value exists only for the duration of one `RUN` and never
reaches a layer. In a build that handles both a Copilot token and a Bitbucket
token, that matters more than the orchestration reuse does.

What we give up is the pipe's clone and devcontainer-build steps, which Jenkins
performs itself instead. That turns out to be a gain rather than a cost: the
pipe's `devcontainer build --workspace-folder` passes no `--config`, so it
cannot address a repository using the multi-config layout
(`.devcontainer/<name>/devcontainer.json`), which the CLI's auto-resolution does
not discover.

See ADR 0002 for what remains shared.
