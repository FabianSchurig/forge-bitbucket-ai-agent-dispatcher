# AI Agent Dispatch

Triggering an AI coding agent from a Bitbucket event, and running it against
another repository inside that repository's own development environment.

This glossary is the shared vocabulary for this repo, for any Jenkins shared
library that consumes it, and for the repositories the agent is pointed at.
Several of these terms collide with words that already mean something else in
Jenkins or in Bitbucket, which is why they are pinned here.

## Language

**Source repository**:
The repository the agent is pointed at and reasons about. Never the repository
the agent's own code lives in.
_Avoid_: spoke, target repository, application repo

**Agent**:
The AI coding agent — the thing that reads code and writes a review. In a
Jenkinsfile, `agent { label 'docker' }` refers to a build node instead; never
use the bare word for that.
_Avoid_: bot, assistant, AI

**Build node**:
The Jenkins machine executing a pipeline. Named explicitly to keep "agent" free
for the AI.
_Avoid_: Jenkins agent, executor, slave

**Base image**:
The source repository's devcontainer, built and pushed. The `FROM` of the agent
image, and the reason the agent sees the same toolchain a developer does.
_Avoid_: TARGET_IMAGE, SDK image, devcontainer image

**Agent image**:
The base image with an agent profile layered on top. Built once per run,
executed by the build that creates it, and then discarded.

**Agent profile**:
A versioned bundle of everything that defines how one agent behaves — its
command and flags, MCP configuration, instructions and baseline skills. Selected
by `AGENT_TYPE`, and lives under `pipe/config/agents/<type>/`.
_Avoid_: agent type, agent config

**Pipe image**:
The published `ai-agent-pipe` OCI artifact. On Bitbucket it is executed. On
Jenkins it is only ever read from with `COPY --from`, as the versioned source of
agent profiles and the provision/execute scripts.

**Dispatcher**:
The Forge app that turns a Bitbucket pull request comment into a pipeline run.
It decides *that* an agent should run and with what prompt; it never decides
*how* the agent runs.

**Baseline skill**:
A skill shipped inside an agent profile and installed as a Copilot personal
skill. Distinct from a **project skill**, which lives in the source repository's
own `.agents/skills/` and layers over the baseline.
