# Bitbucket AI Agent Dispatcher – Forge App

An [Atlassian Forge](https://developer.atlassian.com/platform/forge/) application for Bitbucket Cloud that acts as an event-driven dispatcher in a Hub-and-Spoke CI/CD architecture.

When a user posts a comment containing a configurable trigger keyword (default: `@agent`) on any Pull Request in the workspace, the app:

1. Extracts the PR context (workspace, repo, branch, comment author, etc.)
2. Triggers a custom pipeline in a central **hub repository** via the Bitbucket Pipelines API
3. Passes the full PR context as pipeline variables so the hub pipeline knows which spoke to act upon
4. Posts a friendly failure comment on the PR if the pipeline cannot be triggered

---

## Architecture

```
Spoke Repository (PR comment: "@agent …")
       │
       ▼
Forge App (Dispatcher)
  ├─ detects trigger keyword
  ├─ fetches PR source-branch via Bitbucket API
  └─ POST /2.0/repositories/{hub-ws}/{hub-repo}/pipelines/
             │
             ▼
       Hub Repository  (ai-agent-hub)
         └─ custom pipeline runs the AI agent logic
```

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

## Configuration (Workspace Settings)

After installation, navigate to your Bitbucket workspace → **Settings → AI Agent Dispatcher Settings** to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| Trigger Keyword | `@agent` | String the app listens for in PR comments |
| Hub Workspace Slug | *(current workspace)* | Workspace containing the hub repository |
| Hub Repository Slug | `ai-agent-hub` | Name of the central hub repository |
| Hub Pipeline Name | `custom: run-agent-session` | Name of the custom pipeline to trigger |
| Pipeline Branch Name | `main` | Branch in the hub repo where the pipeline is defined |

---

## Pipeline Variables Injected

The following variables are passed to the triggered pipeline:

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

- **Unit tests** – `extractTriggerContext`, `buildPipelinePayload`, `fetchRepositoryDetails`, `fetchCommentContent`, `triggerPipeline`, `postFailureComment`, and `runDispatcher` (dispatcher logic)
- **Integration-style unit tests** – `getSettings` and `saveSettings` (Forge Storage interactions)
- **Component tests** – `SettingsForm` (settings UI rendering and form submission)

All Forge APIs (`@forge/api`, `@forge/react`, `@forge/resolver`, `@forge/bridge`) are mocked so the test suite runs in a plain Node.js/jsdom environment with no Atlassian infrastructure required.

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

To promote to production, duplicate the `deploy-and-install` job, change `-e staging` to `-e production`, and trigger it on GitHub Release tag events rather than direct pushes to `main`.

---

## Required Bitbucket Scopes

| Scope | Justification |
|-------|---------------|
| `read:pullrequest:bitbucket` | Fetch PR details (source branch name) |
| `read:repository:bitbucket` | Fetch repository slug and workspace slug from UUIDs |
| `write:pipeline:bitbucket` | Trigger a custom pipeline in the hub repository |
| `write:comment:bitbucket` | Post a failure reply comment on the PR |
| `storage:app` | Persist and retrieve workspace configuration |

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
│       └── deploy-forge-app.yml
└── src/
    ├── index.ts              Entry point – re-exports all Forge handler functions
    ├── types.ts              Shared TypeScript interfaces and defaults
    ├── storage.ts            Forge Storage read/write helpers
    ├── dispatcher.ts         PR comment trigger handler and Bitbucket API helpers
    ├── resolvers.ts          Forge resolver for settings page backend calls
    ├── settings.tsx          Workspace settings UI (Forge UI Kit 2)
    ├── __mocks__/            Manual Jest mocks for @forge/* packages
    └── __tests__/            Unit and component tests
```

---

## License

MIT
