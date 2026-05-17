# Bitbucket AI Agent Dispatcher – Forge App

An [Atlassian Forge](https://developer.atlassian.com/platform/forge/) application for Bitbucket Cloud that acts as an event-driven dispatcher in a Hub-and-Spoke CI/CD architecture.

When a user posts a comment containing a configurable trigger keyword (default: `@agent`) on any Pull Request in the workspace, the app:

1. Extracts the PR context (workspace, repo, branch, comment author, etc.)
2. Uses the configured **CI/CD provider** to trigger a build (Bitbucket Pipelines, Bitbucket on-demand pipelines, or Jenkins)
3. Passes the full PR context as build parameters so the CI environment knows which spoke to act upon
4. Posts a friendly failure comment on the PR if the build cannot be triggered

---

## Architecture

The app uses the **Strategy Pattern** and **Factory Pattern** to support multiple CI/CD providers without any `if/else` branching in the core dispatch logic:

```
Spoke Repository (PR comment: "@agent …")
       │
       ▼
Forge App (Dispatcher)
  ├─ detects trigger keyword
  ├─ fetches PR source-branch via Bitbucket API
  ├─ ProviderFactory.getProvider()          ← Factory Pattern
  │     ├─ BitbucketPipelinesProvider       ← Strategy A (hub repo + custom pipeline)
  │     ├─ BitbucketOndemandProvider        ← Strategy B (on-demand YAML, no hub repo)
  │     └─ JenkinsProvider                  ← Strategy C
  └─ ciProvider.triggerBuild(payload)       ← Strategy Pattern
              │
              ▼
       CI Environment (Bitbucket Pipelines, on-demand pipelines, or Jenkins)
         └─ runs the AI agent logic
```

### Choosing a provider

| Provider | Hub repo required? | YAML lives in… | Best for |
|---|---|---|---|
| `BITBUCKET_PIPELINES` | Yes – central `ai-agent-hub` repo with `bitbucket-pipelines.yml` | the hub repo (versioned in git) | Teams who want their pipeline definition tracked in git |
| `BITBUCKET_ONDEMAND` | **No** – the YAML is sent in the API request | the project settings (this app) | Teams who want a one-config, no-hub-repo setup ([Bitbucket on-demand pipelines, announced 2026-04-22](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/)) |
| `JENKINS` | n/a – uses an existing Jenkins job | Jenkins | Teams already invested in Jenkins |

For the on-demand provider, the following variables are passed as query parameters and exposed inside the running pipeline as environment variables:

| Variable | Description |
|---|---|
| `$SOURCE_WORKSPACE` | Bitbucket workspace slug of the spoke repo |
| `$SOURCE_REPO` | Repository slug of the spoke repo |
| `$PR_ID` | Pull-request numeric ID |
| `$SOURCE_BRANCH` | Source branch of the PR |
| `$COMMENT_TEXT` | Raw text of the triggering comment |
| `$COMMENT_AUTHOR` | Atlassian account ID of the comment author |

### Adding a New Provider

1. Create a new class in `src/providers/` that implements `CIProvider`
2. Register it in `src/factories/ProviderFactory.ts` (add a `case` to the `switch`)
3. Add provider-specific fields to `AppConfig` in `src/types.ts`
4. Add the provider option to the settings UI in `src/settings.tsx`
5. Declare any new egress domains in `manifest.yml`

---

## Requirements

| Tool | Version |
|------|---------|
| Node.js | 18 or later |
| npm | 9 or later |
| Atlassian Forge CLI | latest (`npm i -g @forge/cli`) |

---

## First-Time Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/FabianSchurig/forge-bitbucket-ai-agent-dispatcher.git
cd forge-bitbucket-ai-agent-dispatcher
npm install
```

### 2. Register the app with Atlassian (once per developer)

```bash
forge login
```

If you are creating the app for the first time, register it and update the `app.id` field in `manifest.yml`:

```bash
forge create        # follow the prompts; copy the generated app ID into manifest.yml
```

If the app already exists, the `app.id` in `manifest.yml` is already set.

### 3. Deploy the app

```bash
forge deploy -e development
```

### 4. Install the app on your Bitbucket workspace

```bash
forge install --non-interactive --site bitbucket.org/fabian-schurig --product bitbucket --environment development
```

> **Important:** The first install must be performed manually from a developer machine.
> The CI/CD pipeline uses `forge install --upgrade` which requires an existing installation UUID.

---

## Configuration (Project Settings)

After installation, navigate to your Bitbucket **Project → Settings → AI Agent Dispatcher Settings** to configure. Configuration is scoped to the Bitbucket project — all repositories within the project inherit the same CI/CD settings. Bitbucket natively restricts this page to Project Admins via RBAC.

### General Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Trigger Keyword | `@agent` | String the app listens for in PR comments |
| CI/CD Provider | `Bitbucket Pipelines` | Which CI/CD backend to use |

### Bitbucket Pipelines Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Hub Workspace Slug | *(current workspace)* | Workspace containing the hub repository |
| Hub Repository Slug | `ai-agent-hub` | Name of the central hub repository |
| Hub Pipeline Name | `custom: run-agent-session` | Name of the custom pipeline to trigger |
| Pipeline Branch Name | `main` | Branch in the hub repo where the pipeline is defined |

### Jenkins Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Jenkins URL | *(empty)* | Base URL of the Jenkins instance (e.g. `https://jenkins.example.com`) |
| Jenkins Job Path | *(empty)* | Path to the Jenkins job (e.g. `job/my-folder/job/my-job`) |

> **Security:** The Jenkins API token must be stored using Forge Encrypted Storage:
> ```bash
> forge storage set-secret --key jenkins-api-token --value YOUR_BASE64_TOKEN
> ```

---

## Pipeline Variables / Build Parameters

The following variables are passed to the triggered build:

| Variable | Description |
|----------|-------------|
| `SOURCE_WORKSPACE` | Workspace slug of the spoke repository |
| `SOURCE_REPO` | Repository slug of the spoke repository |
| `PR_ID` | Pull-request ID (as string) |
| `SOURCE_BRANCH` | Source branch of the pull request |
| `COMMENT_TEXT` | Full plaintext content of the triggering comment |
| `COMMENT_AUTHOR` | Atlassian account ID of the comment author |

---

## Running Tests

```bash
npm test                    # run all tests
npm run test:coverage       # run tests with coverage report
```

The test suite covers:

- **Unit tests** – `CIProviderError`, `BitbucketPipelinesProvider`, `JenkinsProvider`, `ProviderFactory`
- **Integration tests** – `extractTriggerContext`, `buildPipelinePayload`, `fetchRepositoryDetails`, `fetchCommentContent`, `triggerPipeline`, `postFailureComment`, and `runDispatcher` (dispatcher logic)
- **Storage tests** – `getSettings` and `saveSettings` (Forge Storage interactions)
- **Component tests** – `SettingsForm` (settings UI rendering, CI provider selection, and form submission)

All Forge APIs (`@forge/api`, `@forge/react`, `@forge/resolver`, `@forge/bridge`, `@forge/kvs`) are mocked so the test suite runs in a plain Node.js/jsdom environment with no Atlassian infrastructure required.

---

## CI/CD – Automated Deployment (GitHub Actions)

The workflow at `.github/workflows/deploy-forge-app.yml` automatically runs tests, lints the Forge code, deploys to development, and upgrades the workspace installation on every push to `main`.

### Prerequisites

Add the following **Repository Secrets** under
`Settings → Secrets and variables → Actions`:

| Secret | Description |
|--------|-------------|
| `FORGE_EMAIL` | Email address of the Atlassian Developer account that owns the app |
| `FORGE_API_TOKEN` | Atlassian API token (generate at [Atlassian Account Security](https://id.atlassian.com/manage-profile/security)) |

> The Forge CLI uses these environment variables to authenticate headlessly, bypassing the interactive login prompt that would hang in a CI environment.
> Do **not** use third-party "Forge Deploy" actions from the GitHub Marketplace – the official `@forge/cli` npm package is Atlassian's supported CI/CD method.

### Workflow steps

1. Checkout code
2. Install Node 18 and project dependencies
3. Install `@forge/cli` globally
4. Disable usage analytics
5. `forge lint` – validate the manifest and code
6. `forge deploy -e development` – deploy new code
7. `forge install --upgrade --non-interactive --site bitbucket.org/fabian-schurig --product bitbucket --environment development` – apply the update to the installed workspace

### Production deployments

Production deployments are handled by a separate, release-driven workflow at
`.github/workflows/release-forge-app.yml`. It fires on **GitHub Release**
publish events (or via manual `workflow_dispatch`) so that every production
build is tied to a Git tag.

The workflow ships the app in **two variants** from the same source tree:

| Variant | Build-time differences | Intended audience |
|---------|------------------------|-------------------|
| `full`  | Ships `manifest.yml` as-is, including the `permissions.external.fetch.backend: ['*']` wildcard, and `JENKINS_ENABLED = true` in `src/featureFlags.ts`. | Teams that want the Jenkins integration. |
| `lite`  | `permissions.external` is stripped from `manifest.yml` by `yq`, **and** the `JENKINS_ENABLED` compile-time flag in `src/featureFlags.ts` is flipped to `false` by `sed` so the Jenkins option is hidden from the settings UI and the backend `ProviderFactory` refuses to instantiate it. | Security-conscious teams that prefer a minimum-permissions install. |

The `lite` variant is deployed under a **separate Forge app id** (so it can
be listed as its own Marketplace app), which means it requires one extra
repository secret:

| Secret | Description |
|--------|-------------|
| `FORGE_APP_ID_LITE` | The Forge ARI of the lite app (`ari:cloud:ecosystem::app/...`). Run `forge create` once locally to mint it. If the secret is not set, the `lite` matrix leg is skipped automatically. |

To cut a production release:

1. Push a tag (e.g. `v1.2.0`) and publish a GitHub Release pointing at it.
2. The `release-forge-app.yml` workflow runs `forge lint` → `forge deploy -e production --non-interactive` for both variants in parallel, then upgrades the owning workspace installation.

See the Atlassian docs on [staging and production apps](https://developer.atlassian.com/platform/forge/staging-and-production-apps/), [distributing your app](https://developer.atlassian.com/platform/forge/distribute-your-apps/), and [listing Forge apps on the Marketplace](https://developer.atlassian.com/platform/marketplace/listing-forge-apps/) for the one-off setup steps (creating the second app id, submitting each variant to the Marketplace, etc.).

---

## Required Bitbucket Scopes

| Scope | Justification |
|-------|---------------|
| `read:pullrequest:bitbucket` | Fetch PR details (source branch name) |
| `read:repository:bitbucket` | Fetch repository slug and workspace slug from UUIDs |
| `write:pipeline:bitbucket` | Trigger a custom pipeline in the hub repository |
| `write:pullrequest:bitbucket` | Post a failure reply comment on the PR |
| `read:pipeline:bitbucket` | Check build status via Bitbucket Pipelines API |
| `storage:app` | Persist and retrieve workspace configuration |

---

## External Egress Permissions

| Domain | Justification |
|--------|---------------|
| `jenkins.mycompany.com` | Example Jenkins hostname. Admins must update `manifest.yml` with their actual Jenkins server domain. Avoid wildcard domains unless strictly necessary. |

> **Important:** Forge blocks all outbound HTTP requests to domains not declared in `manifest.yml`. If using Jenkins, set this to your actual Jenkins server domain (for example, `jenkins.mycompany.com`) and avoid wildcards unless they are strictly required.

---

## Project Structure

```
.
├── manifest.yml              Forge app manifest (modules, functions, permissions)
├── package.json
├── tsconfig.json
├── jest.config.js
├── babel.config.js
├── .github/
│   └── workflows/
│       ├── deploy-forge-app.yml      CI: lint + test + deploy to development on every push/PR
│       └── release-forge-app.yml     CD: deploy `full` and `lite` variants to production on release
└── src/
    ├── index.ts              Entry point – re-exports all Forge handler functions
    ├── types.ts              Shared TypeScript interfaces and defaults
    ├── storage.ts            Project-scoped Forge Storage read/write helpers
    ├── pipelinePayload.ts    Shared Bitbucket Pipelines payload builder
    ├── dispatcher.ts         PR comment trigger handler and Bitbucket API helpers
    ├── resolvers.ts          Forge resolver for settings + startDeployment
    ├── settings.tsx          Project settings UI (Forge UI Kit 2)
    ├── interfaces/           CIProvider contract and CIProviderError
    │   ├── CIProvider.ts     Strategy Pattern interface
    │   ├── CIProviderError.ts Standardised error class for all providers
    │   └── index.ts          Re-exports
    ├── providers/            Provider implementations (Strategy Pattern)
    │   ├── BitbucketPipelinesProvider.ts
    │   ├── JenkinsProvider.ts
    │   └── index.ts          Re-exports
    ├── factories/            Factory for instantiating providers
    │   ├── ProviderFactory.ts
    │   └── index.ts          Re-exports
    ├── __mocks__/            Manual Jest mocks for @forge/* packages
    └── __tests__/            Unit and component tests
```

---

## License

GNU Affero General Public License v3.0 (AGPL-3.0-or-later). See [LICENSE](LICENSE) for the full text.
