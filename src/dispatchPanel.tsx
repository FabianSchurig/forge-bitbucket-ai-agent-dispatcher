/**
 * Jira issue-context panel for the AI Agent Dispatcher (Phase 2).
 *
 * Rendered natively by Forge (manifest `jira:issueContext`, `render: native`)
 * inside the right-hand context panel of a Jira issue.  It lets a developer:
 *   1. Pick a target Bitbucket repository (fetched via the backend resolver).
 *   2. Review/edit an auto-generated branch name derived from the issue summary.
 *   3. Dispatch an AI-agent pipeline, then see the returned pipeline link.
 *
 * All product/data access goes through the backend resolvers in
 * src/jiraResolvers.ts via @forge/bridge `invoke`, so this component contains
 * no secrets and no direct REST calls.
 *
 * Per repository convention (AGENTS.md) the UI uses only @forge/react UI Kit
 * components — never raw HTML elements.
 */

import React, { useState, useEffect } from 'react';
import ForgeReconciler, {
  Button,
  Heading,
  Label,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Text,
  Textfield,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';

/** Repository entry returned by the fetchRepositories resolver. */
interface RepositoryOption {
  workspace: string;
  repoSlug: string;
  fullName: string;
}

/** Result returned by the dispatchAgent resolver. */
interface DispatchResult {
  success: boolean;
  message: string;
  branch?: string;
  buildUrl?: string;
}

/** Select change events deliver the chosen option directly. */
type ForgeSelectEvent = { label: string; value: string } | null;
/** Textfield change events carry the new value on target.value. */
type ForgeInputEvent = { target: { value?: unknown } };

export const DispatchPanel = (): React.ReactElement => {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [issueKey, setIssueKey] = useState('');
  const [summary, setSummary] = useState('');
  const [branch, setBranch] = useState('');

  const [repos, setRepos] = useState<RepositoryOption[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<RepositoryOption | null>(null);

  const [dispatching, setDispatching] = useState(false);
  const [result, setResult] = useState<DispatchResult | null>(null);

  // On mount: read the issue key from the Forge context, then load the issue
  // context (summary + suggested branch) and the list of repositories.
  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const ctx = await view.getContext();
        const ext = ctx?.extension as Record<string, unknown> | undefined;
        const issue = ext?.issue as Record<string, unknown> | undefined;
        const key = (issue?.key as string) ?? '';

        // Fetch issue context and repositories in parallel.
        const [context, repoList] = await Promise.all([
          invoke('getJiraContext', { issueKey: key }) as Promise<{
            issueKey: string;
            summary: string;
            suggestedBranch: string;
          }>,
          invoke('fetchRepositories', {}) as Promise<RepositoryOption[]>,
        ]);

        setIssueKey(context.issueKey);
        setSummary(context.summary);
        setBranch(context.suggestedBranch);
        setRepos(repoList);
      } catch (err) {
        console.error('DispatchPanel: failed to load panel data:', err);
        setLoadError('Could not load dispatcher data. Please reload the issue.');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const handleDispatch = async (): Promise<void> => {
    if (!selectedRepo) {
      return;
    }
    setDispatching(true);
    setResult(null);
    try {
      const dispatchResult = (await invoke('dispatchAgent', {
        workspace: selectedRepo.workspace,
        repoSlug: selectedRepo.repoSlug,
        issueKey,
        issueSummary: summary,
        branch,
      })) as DispatchResult;
      setResult(dispatchResult);
    } catch (err) {
      console.error('DispatchPanel: dispatch failed:', err);
      setResult({ success: false, message: 'Dispatch failed. Please try again.' });
    } finally {
      setDispatching(false);
    }
  };

  if (loading) {
    return <Spinner label="Loading dispatcher…" />;
  }

  if (loadError) {
    return (
      <SectionMessage appearance="error" title="Error">
        <Text>{loadError}</Text>
      </SectionMessage>
    );
  }

  return (
    <Stack space="space.150">
      <Heading as="h3">AI Agent Dispatcher</Heading>
      <Text>
        Issue {issueKey}: {summary}
      </Text>

      <Label labelFor="repo-select">Target repository</Label>
      <Select
        id="repo-select"
        appearance="default"
        placeholder="Select a repository…"
        options={repos.map((r) => ({ label: r.fullName, value: r.fullName }))}
        onChange={(e: ForgeSelectEvent) => {
          const match = repos.find((r) => r.fullName === e?.value) ?? null;
          setSelectedRepo(match);
        }}
      />

      <Label labelFor="branch-field">Branch name</Label>
      <Textfield
        id="branch-field"
        value={branch}
        onChange={(e: ForgeInputEvent) => setBranch(String(e.target.value ?? ''))}
      />

      <Button
        appearance="primary"
        isDisabled={!selectedRepo || dispatching}
        onClick={handleDispatch}
      >
        {dispatching ? 'Dispatching…' : 'Dispatch agent'}
      </Button>

      {result && (
        <SectionMessage
          appearance={result.success ? 'success' : 'error'}
          title={result.success ? 'Agent dispatched' : 'Dispatch failed'}
        >
          <Text>{result.message}</Text>
          {result.success && result.buildUrl && (
            <Text>Pipeline: {result.buildUrl}</Text>
          )}
        </SectionMessage>
      )}
    </Stack>
  );
};

// Mount the component tree when Forge loads this file (render: native).
ForgeReconciler.render(
  <React.StrictMode>
    <DispatchPanel />
  </React.StrictMode>,
);
