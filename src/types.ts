/**
 * Shared TypeScript types for the Forge Bitbucket AI Agent Dispatcher.
 */

/** Configuration stored in Forge Storage for the dispatcher app. */
export interface AppConfig {
  /** The keyword that triggers the agent pipeline (e.g. "@agent"). */
  triggerKeyword: string;
  /** Workspace slug of the hub repository. Empty string means "use the current workspace". */
  hubWorkspace: string;
  /** Repository slug of the hub repository. */
  hubRepository: string;
  /** Name of the custom pipeline to trigger (e.g. "custom: run-agent-session"). */
  hubPipeline: string;
  /** Branch in the hub repository where the pipeline definition exists. */
  pipelineBranch: string;
}

/** Default configuration values. */
export const DEFAULT_CONFIG: AppConfig = {
  triggerKeyword: '@agent',
  hubWorkspace: '',
  hubRepository: 'ai-agent-hub',
  hubPipeline: 'custom: run-agent-session',
  pipelineBranch: 'main',
};

/** Context extracted from a pull-request comment event. */
export interface DispatchContext {
  /** Workspace UUID from the Forge event (e.g. "{uuid-here}"). */
  workspaceUuid: string;
  /** Repository UUID from the Forge event (e.g. "{uuid-here}"). */
  repoUuid: string;
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
