# GitHub Copilot Instructions

## Project Overview

This repository contains an **Atlassian Forge application** for Bitbucket Cloud called the *AI Agent Dispatcher*. It is a lightweight event-driven routing layer: it listens for trigger keywords in Pull Request comments and dispatches a custom pipeline in a central "hub" repository via the Bitbucket Pipelines API.

The app does **not** contain AI logic. Its only responsibility is translating a PR comment event into a correctly-shaped Bitbucket Pipelines API call.

---

## Architecture

```
Spoke Repo  ──(PR comment "@agent …")──▶  Forge App (Dispatcher)
                                               │
                                    ┌──────────┴──────────┐
                                    │  1. keyword check   │
                                    │  2. fetch PR branch │
                                    │  3. POST pipeline   │
                                    └──────────┬──────────┘
                                               │
                                     Hub Repo  ▼
                                    (custom: run-agent-session)
```

**Forge modules used:**

| Module | Purpose |
|--------|---------|
| `trigger` (`avi:bitbucket:created:pullrequest:comment`) | Fires `runDispatcher` on every new PR comment |
| `bitbucket:workspaceSettings:settingsPage` | Workspace admin UI for configuration |
| `function` (resolver) | Backend handler for settings read/write invocations |

---

## Repository Structure

```
.github/
  copilot-instructions.md     ← this file
  workflows/
    deploy-forge-app.yml      ← CI/CD: test → forge lint → forge deploy → forge install
manifest.yml                  ← Forge app manifest (modules, permissions, runtime)
package.json
tsconfig.json
jest.config.js
babel.config.js
src/
  index.ts                    ← re-exports all Forge handler functions
  types.ts                    ← AppConfig, DispatchContext, PipelinePayload interfaces
  storage.ts                  ← getSettings / saveSettings via Forge Storage API
  dispatcher.ts               ← core trigger logic + Bitbucket API helpers
  resolvers.ts                ← Forge resolver (getSettings / saveSettings for UI)
  settings.tsx                ← Settings UI – Forge UI Kit 2 (@forge/react)
  __mocks__/@forge/           ← manual Jest mocks for all @forge/* packages
  __tests__/
    dispatcher.test.ts
    storage.test.ts
    settings.test.tsx
    setup.ts                  ← @testing-library/jest-dom setup for jsdom project
```

---

## Key Technologies

- **Runtime**: Node.js 18, TypeScript 5, Forge serverless platform
- **Forge packages**: `@forge/api` (Bitbucket API + Storage), `@forge/react` (UI Kit 2), `@forge/resolver`
- **Testing**: Jest 29, Babel (ts + react), `@testing-library/react` (jsdom for `.tsx` tests)
- **CI/CD**: GitHub Actions – authenticates via `FORGE_EMAIL` / `FORGE_API_TOKEN` secrets

---

## Coding Conventions

### TypeScript
- **Strict mode** is enabled. Avoid `any`; use `unknown` and narrow with guards.
- All public functions must have explicit return types.
- Use `Record<string, unknown>` (not `object` or `{}`) when the shape is not fully known.
- Prefer `const` over `let`; never use `var`.

### Forge API calls
- All Bitbucket API calls use `api.asApp().requestBitbucket(route\`...\`)`.
- The `route` tagged template literal from `@forge/api` handles URL encoding — always use it for path parameters; never interpolate directly into a string URL.
- Check `response.ok` before calling `response.json()`. Throw a descriptive `Error` on failure so the caller can decide whether to post a PR comment.

### Error handling
- Dispatcher errors are caught at the top level in `runDispatcher`. On failure, `postFailureComment` posts a friendly message to the PR. `postFailureComment` itself never throws — it swallows secondary errors.
- Log with `console.log` for normal flow and `console.error` for failures (Forge developer console).

### Settings / Storage
- All persistent settings live under the single storage key `'appConfig'`.
- `getSettings()` always returns a fully-populated `AppConfig` (merges stored values with `DEFAULT_CONFIG`). Callers never need to handle partial objects.
- `saveSettings()` accepts `Partial<AppConfig>` and merges on top of current persisted values.

### React / UI Kit 2
- The `SettingsForm` component is exported (named export) so it can be unit-tested in isolation.
- `renderSettings()` is the Forge handler export that calls `ForgeReconciler.render()`. It is the only entry point that touches the Forge runtime.
- Use `invoke` from `@forge/bridge` (not direct storage access) inside React components — UI Kit 2 runs in a sandboxed context.

---

## Testing Conventions

- **All `@forge/*` packages are mocked** — tests run in a plain Node.js/jsdom environment with no Atlassian infrastructure.
- Manual mock files live in `src/__mocks__/@forge/`. They always include `export const __esModule = true` so Babel's `_interopRequireDefault` resolves imports correctly.
- Inline `jest.mock()` factories inside test files also include `__esModule: true` for the same reason.
- After calling `jest.mock('@forge/api', factory)`, retrieve stable mock references via `jest.requireMock('@forge/api')` — **never** reference outer `let` variables from inside a `jest.mock()` factory (hoisting issue).
- `.ts` test files run in the `node` Jest project; `.tsx` test files run in the `jsdom` Jest project.
- All mock functions must be reset in `beforeEach` to prevent cross-test pollution.

### Running the test suite
```bash
npm test                  # all suites
npm run test:coverage     # with coverage report
```

---

## Manifest Conventions

- Function handler format: `src/file.namedExport` (e.g. `src/index.runDispatcher`).
- Each Forge `function` key maps 1-to-1 to a named export in `src/index.ts`.
- Permission scopes follow least-privilege: only the four scopes in `manifest.yml` are required. Do not add scopes without a documented justification.

---

## CI/CD Workflow

File: `.github/workflows/deploy-forge-app.yml`

| Job | Trigger | Steps |
|-----|---------|-------|
| `test` | push to `main` | `npm ci` → `npm test` |
| `deploy-and-install` | after `test` passes | `npm ci` → `forge lint` → `forge deploy -e staging` → `forge install --upgrade --non-interactive` |

Authentication uses two **repository secrets** (`FORGE_EMAIL`, `FORGE_API_TOKEN`). The first deploy/install must always be performed manually from a developer machine before CI can use `--upgrade`.

---

## What NOT to Do

- Do **not** hardcode Atlassian credentials or API tokens anywhere in source files.
- Do **not** add third-party "Forge Deploy" GitHub Actions marketplace wrappers — use the official `@forge/cli` npm package.
- Do **not** call `storage.set` / `storage.get` directly inside React components; use `invoke` → resolver instead.
- Do **not** interpolate URL path segments directly into strings passed to `requestBitbucket` — always use the `route` tag.
- Do **not** expand the permission scopes in `manifest.yml` without updating the scope-justification table in `README.md`.
