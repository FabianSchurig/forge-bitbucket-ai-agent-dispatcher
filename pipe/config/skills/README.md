# Baseline skills

Skills in this directory are shared by every agent profile. `provision.sh`
installs them into the profile's personal skills directory inside the agent
image — `$HOME/.copilot/skills/` for Copilot, `$HOME/.cursor/skills/` for
Cursor — as set by `AGENT_SKILLS_DIR` in the profile's `agent.env`. A profile
may ship extra skills of its own under `config/agents/<profile>/skills/`; those
are installed after these and win on a name clash.

## How this composes with a source repository

Both agents merge personal skills with *project* skills — anything under
`.agents/skills/` (and the agent's own project directory, e.g.
`.github/skills/` or `.cursor/skills/`) in the workspace. So:

- Skills here are the floor. Every agent run gets them, including runs against a
  repository that has never heard of skills.
- A source repository's own `.agents/skills/` layers on top and can replace a
  baseline skill by using the same `name`.

A repository that already vendors its own skill set gets those loaded
automatically from the workspace and needs nothing from here. Keep this
directory small — it is for skills that must exist regardless of the repository,
not a general-purpose library.

## Writing one

Each skill is a directory containing `SKILL.md` with `name` and `description`
frontmatter. Both fields are required; `license` is optional.

Two things that hold for Claude Code but **not** for these headless agents, and
that have already caught us out:

- **There are no slash commands.** The agent selects a skill by matching its
  `description` against the task. `/code-review-custom` in a prompt is just
  text. Write the `description` as the trigger condition, and name the skill in
  the prompt if you need to steer selection.
- **`disable-model-invocation` is ignored.** It is a Claude Code field. A
  recursion or scope guard has to be prose in the body, backed by tool-level
  restrictions on the agent invocation itself.

A skill must work in both modes `execute.sh` can run in: a normal run, where the
agent posts through bb-mcp, and a read-only run (`READ_ONLY=true`), where bb-mcp
exposes only `GET` operations and the agent must print its result instead.
