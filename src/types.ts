/**
 * Shared TypeScript types for the Forge Bitbucket AI Agent Dispatcher.
 */

import type { CIProviderType } from './interfaces/CIProvider';

/** Configuration stored in Forge Storage for the dispatcher app. */
export interface AppConfig {
  /** The keyword that triggers the agent pipeline (e.g. "@agent"). */
  triggerKeyword: string;

  // -- CI Provider selection ------------------------------------------------

  /**
   * Which CI/CD provider to use for dispatching builds.
   * Defaults to 'BITBUCKET_PIPELINES' for backward compatibility.
   */
  ciType: CIProviderType;

  // -- Bitbucket Pipelines settings -----------------------------------------

  /** Workspace slug of the hub repository. Empty string means "use the current workspace". */
  hubWorkspace: string;
  /** Repository slug of the hub repository. */
  hubRepository: string;
  /** Name of the custom pipeline to trigger (e.g. "custom: run-agent-session"). */
  hubPipeline: string;
  /** Branch in the hub repository where the pipeline definition exists. */
  pipelineBranch: string;

  // -- Bitbucket on-demand pipelines settings -------------------------------

  /**
   * Optional override for the target repository when running an on-demand
   * pipeline.  Format: "{workspaceSlug}/{repoSlug}".  When empty, the
   * pipeline runs against the spoke repository where the triggering PR
   * comment was posted (no central hub repo required).
   *
   * Only used when ciType is 'BITBUCKET_ONDEMAND'.
   */
  ondemandTargetRepo: string;
  /**
   * Optional override for the branch the on-demand pipeline runs against.
   * When empty, the pipeline runs against the source branch of the PR.
   *
   * Only used when ciType is 'BITBUCKET_ONDEMAND'.
   */
  ondemandTargetBranch: string;
  /**
   * The YAML pipeline definition that is POSTed to the on-demand pipelines
   * API as the request body.  Pipeline variables sent via query parameters
   * (SOURCE_WORKSPACE, SOURCE_REPO, PR_ID, SOURCE_BRANCH, COMMENT_TEXT,
   * COMMENT_AUTHOR) are exposed to the steps as ordinary environment
   * variables and can be referenced as $VARIABLE_NAME.
   *
   * Only used when ciType is 'BITBUCKET_ONDEMAND'.
   */
  ondemandYamlTemplate: string;

  // -- Jenkins settings -----------------------------------------------------

  /**
   * Base URL of the Jenkins instance (e.g. "https://jenkins.example.com").
   * Only used when ciType is 'JENKINS'.
   */
  jenkinsUrl: string;
  /**
   * Full path of the Jenkins job to trigger (e.g. "job/my-folder/job/my-job").
   * Only used when ciType is 'JENKINS'.
   */
  jenkinsJobPath: string;

  // -- Monitoring -----------------------------------------------------------

  /**
   * When true, the dispatcher records each dispatch event (success, failure,
   * skipped) in Forge Storage for later review in the settings UI.
   */
  monitoringEnabled: boolean;
}

/**
 * Default YAML body for on-demand pipelines.
 *
 * Runs the bundled ai-agent-pipe directly, so admins can use the on-demand
 * provider without provisioning a separate hub repository.
 *
 * The variables referenced as $VARIABLES are populated via query parameters
 * sent alongside this body — see src/ondemandPipelinePayload.ts.
 */
export const DEFAULT_ONDEMAND_YAML = `pipelines:
  default:
    - step:
        name: Run ai-agent-pipe
        image: atlassian/default-image:5
        size: 2x
        services:
          - docker
        script:
          - export DOCKER_BUILDKIT=1
          - pipe: docker://ghcr.io/fabianschurig/forge-bitbucket-ai-agent-dispatcher/ai-agent-pipe:latest
            variables:
              AGENT_TYPE: "copilot"
              SOURCE_WORKSPACE: $SOURCE_WORKSPACE
              SOURCE_REPO: $SOURCE_REPO
              SOURCE_BRANCH: $SOURCE_BRANCH
              PR_ID: $PR_ID
              COMMENT_TEXT: $COMMENT_TEXT
              COMMENT_AUTHOR: $COMMENT_AUTHOR
              COPILOT_GITHUB_TOKEN: $COPILOT_GITHUB_TOKEN
              BITBUCKET_TOKEN: $BITBUCKET_TOKEN
              BITBUCKET_USERNAME: $BITBUCKET_USERNAME
              SSH_KEY: $SSH_KEY

definitions:
  services:
    docker:
      memory: 4096
`;

/** Default configuration values. */
export const DEFAULT_CONFIG: AppConfig = {
  triggerKeyword: '@agent',
  ciType: 'BITBUCKET_PIPELINES',
  hubWorkspace: '',
  hubRepository: 'ai-agent-hub',
  hubPipeline: 'custom: run-agent-session',
  pipelineBranch: 'main',
  ondemandTargetRepo: '',
  ondemandTargetBranch: '',
  ondemandYamlTemplate: DEFAULT_ONDEMAND_YAML,
  jenkinsUrl: '',
  jenkinsJobPath: '',
  monitoringEnabled: false,
};

// ---------------------------------------------------------------------------
// Monitoring types
// ---------------------------------------------------------------------------

/** Possible outcomes for a dispatch event. */
export type DispatchStatus = 'SUCCESS' | 'FAILURE' | 'SKIPPED';

/**
 * A single monitoring event recorded when the dispatcher processes
 * (or skips) a PR comment.
 */
export interface DispatchEvent {
  /** ISO 8601 timestamp of the event. */
  timestamp: string;
  /**
   * Bitbucket project UUID that this event belongs to.
   * Events are scoped by project so the settings UI only shows events
   * relevant to the current project context.
   */
  projectUuid: string;
  /** Workspace UUID where the event originated. */
  workspaceUuid: string;
  /** Repository UUID where the event originated. */
  repoUuid: string;
  /** Pull-request ID. */
  prId: number;
  /** Comment ID that triggered (or was evaluated by) the dispatcher. */
  commentId: number;
  /** Outcome of the dispatch attempt. */
  status: DispatchStatus;
  /** CI provider that handled the build (empty for SKIPPED events). */
  provider: string;
  /** Human-readable description of what happened. */
  message: string;
  /** Optional URL to the triggered build. */
  buildUrl?: string;
}

/** Context extracted from a pull-request comment event. */
export interface DispatchContext {
  /** Workspace UUID from the Forge event (e.g. "{uuid-here}"). */
  workspaceUuid: string;
  /** Repository UUID from the Forge event (e.g. "{uuid-here}"). */
  repoUuid: string;
  /**
   * Bitbucket project UUID from the Forge event (e.g. "{uuid-here}").
   * Used to look up project-scoped configuration.
   * Empty string if the repository is not part of a project.
   */
  projectUuid: string;
  /** Workspace slug of the spoke repository (populated via API). */
  workspace: string;
  /** Repository slug of the spoke repository (populated via API). */
  repoSlug: string;
  /** Pull-request ID in the spoke repository. */
  prId: number;
  /** Source branch of the pull request (available directly from the event). */
  sourceBranch: string;
  /** Full plaintext content of the triggering comment (populated via API). */
  commentText: string;
  /** Account ID of the user who posted the comment. */
  commentAuthor: string;
  /** ID of the triggering comment (used when posting a failure reply). */
  commentId: number;
}

/** A single pipeline variable sent in the dispatch payload. */
export interface PipelineVariable {
  key: string;
  value: string;
}

/** Shape of the Bitbucket Pipelines API POST body. */
export interface PipelinePayload {
  target: {
    type: 'pipeline_ref_target';
    ref_type: 'branch';
    ref_name: string;
    selector: {
      type: 'custom';
      pattern: string;
    };
  };
  variables: PipelineVariable[];
}
