# Baseline skills

Skills in this directory are installed by
[`provision.sh`](../../../../scripts/provision.sh) into
`$HOME/.copilot/skills/` inside the agent image, where Copilot picks them up as
*personal* skills.

## How this composes with a source repository

Copilot merges personal skills with *project* skills — anything under
`.agents/skills/`, `.claude/skills/` or `.github/skills/` in the workspace. So:

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
frontmatter. Both fields are required by Copilot; `license` is optional.

Two things that hold for Claude Code but **not** for Copilot, and that have
already caught us out:

- **There are no slash commands.** Copilot selects a skill by matching its
  `description` against the task. `/code-review-custom` in a prompt is just
  text. Write the `description` as the trigger condition, and name the skill in
  the prompt if you need to steer selection.
- **`disable-model-invocation` is ignored.** It is a Claude Code field. A
  recursion or scope guard has to be prose in the body, backed by tool-level
  restrictions on the agent invocation itself.
