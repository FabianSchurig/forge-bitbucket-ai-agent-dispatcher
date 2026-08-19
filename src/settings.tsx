import React, { useState, useEffect } from 'react';
import ForgeReconciler, {
  Button,
  DynamicTable,
  Form,
  FormSection,
  HelperMessage,
  Inline,
  Label,
  Lozenge,
  SectionMessage,
  Stack,
  Heading,
  Textfield,
  TextArea,
  Text,
  Select,
  Toggle,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';
import { AppConfig, DEFAULT_CONFIG } from './types';
import type { DispatchEvent } from './types';
import type { CIProviderType } from './interfaces/CIProvider';
import { JENKINS_ENABLED } from './featureFlags';

// The InputEvent type from Forge UI Kit 2 is a serialisable event object (not
// the standard DOM Event). Only target.value is needed here.
type ForgeInputEvent = { target: { value?: unknown } };

// Select change events deliver the selected option value directly.
type ForgeSelectEvent = { value: string; label: string };

/** Available CI provider options for the dropdown. */
const ALL_CI_PROVIDER_OPTIONS: Array<{ label: string; value: CIProviderType }> = [
  { label: 'Bitbucket Pipelines', value: 'BITBUCKET_PIPELINES' },
  { label: 'Bitbucket Pipelines (on-demand)', value: 'BITBUCKET_ONDEMAND' },
  { label: 'Jenkins', value: 'JENKINS' },
];

/**
 * Options shown in the provider dropdown. In the `lite` release variant the
 * compile-time `JENKINS_ENABLED` flag is `false`, which removes the Jenkins
 * row entirely — admins should not see a provider they cannot configure.
 */
const CI_PROVIDER_OPTIONS: Array<{ label: string; value: CIProviderType }> =
  JENKINS_ENABLED
    ? ALL_CI_PROVIDER_OPTIONS
    : ALL_CI_PROVIDER_OPTIONS.filter((opt) => opt.value !== 'JENKINS');

export const SettingsForm = () => {
  // Single state holds both the loaded values and any user edits.
  // Initialised to DEFAULT_CONFIG until storage data loads.
  const [formValues, setFormValues] = useState<AppConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // The Bitbucket project UUID is extracted from the Forge extension context.
  // When the settings page is rendered inside Project Settings, the context
  // includes the project this page belongs to.
  const [projectUuid, setProjectUuid] = useState<string>('');

  // Monitoring events loaded from storage (newest-first).
  const [monitoringEvents, setMonitoringEvents] = useState<DispatchEvent[]>([]);

  useEffect(() => {
    // Retrieve the project UUID from the Forge extension context.
    // For bitbucket:projectSettingsMenuPage, this is at
    // context.extension.project.uuid.
    const loadContext = async (): Promise<void> => {
      try {
        const ctx = await view.getContext();
        const ext = ctx?.extension as Record<string, unknown> | undefined;
        const project = ext?.project as Record<string, unknown> | undefined;
        const uuid = (project?.uuid as string) ?? '';
        if (!uuid) {
          console.warn(
            'SettingsForm: no project UUID found in extension context. ' +
            'Settings will fall back to the legacy global configuration.',
          );
        }
        setProjectUuid(uuid);

        // Pass the project UUID to the resolver so it fetches project-scoped config.
        const data = await invoke<AppConfig>('getSettings', { projectUuid: uuid });
        const loaded = data ?? DEFAULT_CONFIG;
        // In the `lite` build the Jenkins provider does not exist. If a
        // stale stored config still points at it, fall back to the default
        // provider so the dropdown reflects an option the user can actually
        // pick. The value is not persisted automatically — the admin must
        // press Save — so we don't silently rewrite their stored settings.
        if (!JENKINS_ENABLED && loaded.ciType === 'JENKINS') {
          loaded.ciType = DEFAULT_CONFIG.ciType;
        }
        setFormValues(loaded);

        // Load project-scoped monitoring events (best-effort — errors are silently ignored).
        try {
          const events = await invoke<DispatchEvent[]>('getMonitoringEvents', {
            projectUuid: uuid,
          });
          setMonitoringEvents(events ?? []);
        } catch {
          // Non-critical — the settings page still works without monitoring data.
        }
      } catch (err: unknown) {
        console.error('Failed to load settings:', err);
        setErrorMsg('Failed to load settings. Showing defaults.');
      } finally {
        setLoading(false);
      }
    };
    void loadContext();
  }, []);

  // Helper to update a single text field in formValues state.
  const handleChange =
    (field: keyof AppConfig) =>
    (e: ForgeInputEvent): void => {
      setFormValues((prev: AppConfig) => ({ ...prev, [field]: String(e.target.value ?? '') }));
    };

  // Handler for the CI provider dropdown.
  const handleCiTypeChange = (option: ForgeSelectEvent | null): void => {
    if (option) {
      setFormValues((prev: AppConfig) => ({
        ...prev,
        ciType: option.value as CIProviderType,
      }));
    }
  };

  // Handler for the monitoring toggle.
  const handleMonitoringToggle = (): void => {
    setFormValues((prev: AppConfig) => ({
      ...prev,
      monitoringEnabled: !prev.monitoringEnabled,
    }));
  };

  // -------------------------------------------------------------------
  // Pipeline variable handlers (custom admin-defined variables)
  // -------------------------------------------------------------------
  // The list lives directly in formValues.pipelineVariables.  All mutations
  // are immutable replacements so React re-renders cleanly.
  const updateVariable = (
    index: number,
    patch: Partial<{ key: string; value: string; secured: boolean }>,
  ): void => {
    setFormValues((prev: AppConfig) => {
      const next = [...(prev.pipelineVariables ?? [])];
      next[index] = { ...next[index], ...patch };
      // When the user flips a row from secured → unsecured, the value field
      // becomes a normal Textfield.  Leave whatever value is currently in
      // state so the user can see what they're un-securing.
      return { ...prev, pipelineVariables: next };
    });
  };

  const addVariable = (): void => {
    setFormValues((prev: AppConfig) => ({
      ...prev,
      pipelineVariables: [
        ...(prev.pipelineVariables ?? []),
        { key: '', value: '', secured: false },
      ],
    }));
  };

  const removeVariable = (index: number): void => {
    setFormValues((prev: AppConfig) => {
      const next = [...(prev.pipelineVariables ?? [])];
      next.splice(index, 1);
      return { ...prev, pipelineVariables: next };
    });
  };

  // Form onSubmit must match `() => Promise<void | boolean> | void` (no args).
  const handleSubmit = async (): Promise<void> => {
    setSaved(false);
    setErrorMsg(null);

    // When Jenkins is selected and a URL has been provided, validate the URL
    // format before saving.  Once Customer-Managed Egress reaches preview we
    // can add dynamic domain approval here; for now the manifest wildcard ('*')
    // allows outbound requests to any host.
    if (formValues.ciType === 'JENKINS' && formValues.jenkinsUrl) {
      try {
        const hostname = new URL(formValues.jenkinsUrl).hostname;
        if (!hostname) {
          throw new Error('empty hostname');
        }
      } catch {
        setErrorMsg(
          'Invalid Jenkins URL format. Please enter a valid URL (e.g., https://jenkins.example.com).',
        );
        return;
      }
    }

    // For on-demand pipelines, run a lightweight YAML sanity check so we
    // don't ship an obviously broken pipeline definition to Bitbucket.
    // The provider posts the YAML verbatim — Bitbucket parses it server-side
    // when the pipeline runs, so this client-side check only catches the
    // most common mistakes (empty body, missing top-level `pipelines:` key)
    // before the user discovers them in a failed pipeline run.
    if (formValues.ciType === 'BITBUCKET_ONDEMAND') {
      const yaml = (formValues.ondemandYamlTemplate ?? '').trim();
      if (!yaml) {
        setErrorMsg('On-demand YAML pipeline definition cannot be empty.');
        return;
      }
      // Match `pipelines:` at the start of a line (allowing the document
      // separator `---` and blank lines above it).
      if (!/^pipelines\s*:/m.test(yaml)) {
        setErrorMsg(
          'On-demand YAML must contain a top-level "pipelines:" key. ' +
          'See the Bitbucket on-demand pipelines docs for the expected structure.',
        );
        return;
      }
    }

    try {
      // Pass the project UUID so settings are saved under the project-scoped key.
      await invoke('saveSettings', { config: formValues, projectUuid });
      setSaved(true);
    } catch (err: unknown) {
      console.error('Failed to save settings:', err);
      setErrorMsg('Failed to save settings. Please try again.');
    }
  };

  if (loading) {
    return <Text>Loading settings…</Text>;
  }

  // Determine which CI provider section to show based on the selected ciType.
  const isBitbucketPipelines = formValues.ciType === 'BITBUCKET_PIPELINES';
  const isOndemand = formValues.ciType === 'BITBUCKET_ONDEMAND';
  const isJenkins = formValues.ciType === 'JENKINS';

  return (
    <Stack space="space.200">
      {/*
        The Forge page chrome already shows "AI Agent Dispatcher Settings" as
        the page title — repeating it here would be redundant. Instead, lead
        with a short, friendly explainer so admins immediately understand what
        the app does and how to use it.
      */}
      <SectionMessage appearance="information" title="How it works">
        <Text>
          The AI Agent Dispatcher listens for a trigger keyword in pull request
          comments and starts a CI/CD build that runs your AI agent against the
          PR. Configure the trigger and your provider below, then comment the
          keyword (for example, "@agent please review") on any PR in this
          project to dispatch a run.
        </Text>
      </SectionMessage>

      {errorMsg && (
        <SectionMessage appearance="error" title="Error">
          <Text>{errorMsg}</Text>
        </SectionMessage>
      )}

      {saved && (
        <SectionMessage appearance="success" title="Saved">
          <Text>Settings saved successfully!</Text>
        </SectionMessage>
      )}

      <Form onSubmit={handleSubmit}>
        <FormSection>
          <Label labelFor="triggerKeyword">Trigger Keyword</Label>
          <Textfield
            id="triggerKeyword"
            name="triggerKeyword"
            value={formValues.triggerKeyword}
            placeholder="@agent"
            onChange={handleChange('triggerKeyword')}
          />
          <HelperMessage>
            The keyword that must appear in a PR comment to trigger a build
            (case-sensitive). Mention-style keywords like "@agent" work well;
            use the exact capitalization you expect in comments.
          </HelperMessage>

          <Label labelFor="ciType">CI/CD Provider</Label>
          <Select
            inputId="ciType"
            name="ciType"
            options={CI_PROVIDER_OPTIONS}
            value={CI_PROVIDER_OPTIONS.find((o) => o.value === formValues.ciType)}
            onChange={handleCiTypeChange}
          />
          <HelperMessage>
            Choose where the AI agent build should run. The fields below change
            to match the selected provider.
          </HelperMessage>
        </FormSection>

        {/* Bitbucket Pipelines-specific settings */}
        {isBitbucketPipelines && (
          <FormSection>
            <Heading as="h3">Bitbucket Pipelines Settings</Heading>

            <Label labelFor="hubWorkspace">Hub Workspace Slug</Label>
            <Textfield
              id="hubWorkspace"
              name="hubWorkspace"
              value={formValues.hubWorkspace}
              placeholder="Leave blank to use the current workspace"
              onChange={handleChange('hubWorkspace')}
            />
            <HelperMessage>
              Workspace that owns the hub repository. Leave blank to reuse the
              workspace this PR lives in.
            </HelperMessage>

            <Label labelFor="hubRepository">Hub Repository Slug</Label>
            <Textfield
              id="hubRepository"
              name="hubRepository"
              value={formValues.hubRepository}
              placeholder="ai-agent-hub"
              onChange={handleChange('hubRepository')}
            />
            <HelperMessage>
              Slug of the central repository whose pipeline runs the AI agent
              for every dispatched PR.
            </HelperMessage>

            <Label labelFor="hubPipeline">Hub Pipeline Name</Label>
            <Textfield
              id="hubPipeline"
              name="hubPipeline"
              value={formValues.hubPipeline}
              placeholder="custom: run-agent-session"
              onChange={handleChange('hubPipeline')}
            />
            <HelperMessage>
              Name of the custom pipeline defined in the hub repository's
              bitbucket-pipelines.yml (e.g. "custom: run-agent-session").
            </HelperMessage>

            <Label labelFor="pipelineBranch">Pipeline Branch Name</Label>
            <Textfield
              id="pipelineBranch"
              name="pipelineBranch"
              value={formValues.pipelineBranch}
              placeholder="main"
              onChange={handleChange('pipelineBranch')}
            />
            <HelperMessage>
              Branch of the hub repository to run the pipeline from. Most teams
              use "main".
            </HelperMessage>
          </FormSection>
        )}

        {/* Bitbucket on-demand pipelines settings */}
        {isOndemand && (
          <FormSection>
            <Heading as="h3">Bitbucket On-Demand Pipelines Settings</Heading>

            <SectionMessage appearance="information" title="No hub repository required">
              <Text>
                On-demand pipelines run the YAML below directly via the
                Bitbucket Pipelines API — there is no need to maintain a
                separate ai-agent-hub repository. The following variables are
                dispatched as query parameters and available inside your
                steps as environment variables: $SOURCE_WORKSPACE,
                $SOURCE_REPO, $PR_ID, $SOURCE_BRANCH, $COMMENT_TEXT,
                $COMMENT_AUTHOR. Add any additional variables (including
                secrets) in the "Pipeline Variables" section below.
              </Text>
            </SectionMessage>

            <Label labelFor="ondemandTargetRepo">Target Repository</Label>
            <Textfield
              id="ondemandTargetRepo"
              name="ondemandTargetRepo"
              value={formValues.ondemandTargetRepo}
              placeholder="Leave blank to run in the PR's repository"
              onChange={handleChange('ondemandTargetRepo')}
            />
            <HelperMessage>
              Optional override of the form "workspace/repo". When blank, the
              on-demand pipeline runs in the spoke repository where the PR
              comment was posted.
            </HelperMessage>

            <Label labelFor="ondemandTargetBranch">Target Branch</Label>
            <Textfield
              id="ondemandTargetBranch"
              name="ondemandTargetBranch"
              value={formValues.ondemandTargetBranch}
              placeholder="Leave blank to use the PR source branch"
              onChange={handleChange('ondemandTargetBranch')}
            />
            <HelperMessage>
              Optional override of the branch the pipeline runs against. When
              blank, the source branch of the triggering PR is used.
            </HelperMessage>

            <Label labelFor="ondemandYamlTemplate">YAML Pipeline Definition</Label>
            <TextArea
              id="ondemandYamlTemplate"
              name="ondemandYamlTemplate"
              value={formValues.ondemandYamlTemplate}
              onChange={handleChange('ondemandYamlTemplate')}
            />
            <HelperMessage>
              Raw YAML body that Bitbucket runs as the pipeline. Must contain
              a top-level "pipelines:" key. Reference the dispatched variables
              with $SOURCE_WORKSPACE, $PR_ID, etc.
            </HelperMessage>
          </FormSection>
        )}

        {/* Jenkins-specific settings */}
        {isJenkins && (
          <FormSection>
            <Heading as="h3">Jenkins Settings</Heading>

            <Label labelFor="jenkinsUrl">Jenkins URL</Label>
            <Textfield
              id="jenkinsUrl"
              name="jenkinsUrl"
              value={formValues.jenkinsUrl}
              placeholder="https://jenkins.example.com"
              onChange={handleChange('jenkinsUrl')}
            />
            <HelperMessage>
              Base URL of your Jenkins server, including the scheme (https://).
            </HelperMessage>

            <Label labelFor="jenkinsJobPath">Jenkins Job Path</Label>
            <Textfield
              id="jenkinsJobPath"
              name="jenkinsJobPath"
              value={formValues.jenkinsJobPath}
              placeholder="job/my-folder/job/my-job"
              onChange={handleChange('jenkinsJobPath')}
            />
            <HelperMessage>
              Path to the job that runs the AI agent, relative to the Jenkins
              base URL (e.g. "job/my-folder/job/my-job").
            </HelperMessage>

            <SectionMessage appearance="warning" title="Security Notice">
              <Text>
                Jenkins API tokens are stored using Forge Encrypted Storage and are never visible in plain text.
                Use the Forge CLI to set the token: forge storage set-secret --key jenkins-api-token --value YOUR_BASE64_TOKEN
                The token value should be a Base64-encoded username:apiToken string.
              </Text>
            </SectionMessage>
          </FormSection>
        )}

        {/* Pipeline Variables — admin-defined extras forwarded on every dispatch. */}
        <FormSection>
          <Heading as="h3">Pipeline Variables</Heading>
          <Text>
            Extra variables forwarded with every dispatched pipeline. Use
            this to inject per-project secrets (e.g. COPILOT_GITHUB_TOKEN,
            CURSOR_API_KEY, BITBUCKET_TOKEN, SSH_KEY) without configuring them on every
            spoke repository. When Secured is on, Bitbucket masks the
            value in pipeline logs and the settings page never reads it
            back — leave the value field blank on subsequent saves to keep
            the stored secret unchanged.
          </Text>

          <Stack space="space.200">
            {(formValues.pipelineVariables ?? []).map((variable, index) => (
              <Stack key={`pv-${index}`} space="space.050">
                <Inline space="space.100" alignBlock="center" spread="space-between">
                  <Inline space="space.100" alignBlock="center" grow="fill">
                    <Textfield
                      id={`pv-key-${index}`}
                      name={`pv-key-${index}`}
                      value={variable.key}
                      placeholder="VARIABLE_NAME"
                      onChange={(e: ForgeInputEvent) =>
                        updateVariable(index, {
                          key: String(e.target.value ?? ''),
                        })
                      }
                    />
                    <TextArea
                      id={`pv-value-${index}`}
                      name={`pv-value-${index}`}
                      value={variable.value}
                      placeholder={
                        variable.secured && variable.value === ''
                          ? '•••• (configured — leave blank to keep)'
                          : 'value (multi-line OK — paste full PEM key here)'
                      }
                      onChange={(e: ForgeInputEvent) =>
                        updateVariable(index, {
                          value: String(e.target.value ?? ''),
                        })
                      }
                    />
                  </Inline>
                  <Inline space="space.200" alignBlock="center">
                    <Toggle
                      id={`pv-secured-${index}`}
                      label="Secured"
                      isChecked={variable.secured}
                      onChange={() =>
                        updateVariable(index, { secured: !variable.secured })
                      }
                    />
                    <Button
                      appearance="subtle"
                      onClick={() => removeVariable(index)}
                    >
                      Remove
                    </Button>
                  </Inline>
                </Inline>
              </Stack>
            ))}

            <Inline>
              <Button appearance="default" onClick={addVariable}>
                + Add variable
              </Button>
            </Inline>

            <HelperMessage>
              Variable names must start with a letter or underscore and
              contain only letters, digits, and underscores. Custom
              variables are forwarded by the on-demand provider as indexed
              query parameters (variables[N].key/value/secured). If you use
              the hub-repo provider, the hub's bitbucket-pipelines.yml must
              declare a matching {`{ name: VARIABLE_NAME }`} entry under
              the step's variables: block to consume them.
            </HelperMessage>
          </Stack>
        </FormSection>

        <Button type="submit" appearance="primary">
          Save Settings
        </Button>
      </Form>

      {/* Monitoring section — shows recent dispatch events when enabled. */}
      <Heading as="h2">Monitoring</Heading>
      <Text>
        Optional: keep an audit trail of every dispatch attempt for this
        project. Useful while rolling the app out or debugging trigger
        comments.
      </Text>

      <FormSection>
        <Inline space="space.100" alignBlock="center">
          <Toggle
            id="monitoringEnabled"
            isChecked={formValues.monitoringEnabled}
            onChange={handleMonitoringToggle}
          />
          <Label labelFor="monitoringEnabled">Enable Monitoring</Label>
        </Inline>
        <HelperMessage>
          When on, the dispatcher records each dispatch event (success,
          failure, or skipped). The most recent events appear in a table
          below once they start coming in.
        </HelperMessage>
      </FormSection>

      {formValues.monitoringEnabled && monitoringEvents.length > 0 && (
        <DynamicTable
          head={{
            cells: [
              { key: 'timestamp', content: 'Timestamp' },
              { key: 'status', content: 'Status' },
              { key: 'prId', content: 'PR' },
              { key: 'provider', content: 'Provider' },
              { key: 'message', content: 'Message' },
            ],
          }}
          rows={monitoringEvents.map((evt, index) => ({
            key: `event-${index}`,
            cells: [
              {
                key: `ts-${index}`,
                content: new Date(evt.timestamp).toLocaleString(),
              },
              {
                key: `status-${index}`,
                content: (
                  <Lozenge
                    appearance={
                      evt.status === 'SUCCESS'
                        ? 'success'
                        : evt.status === 'FAILURE'
                          ? 'removed'
                          : 'default'
                    }
                  >
                    {evt.status}
                  </Lozenge>
                ),
              },
              { key: `pr-${index}`, content: `#${evt.prId}` },
              { key: `provider-${index}`, content: evt.provider || '—' },
              { key: `msg-${index}`, content: evt.message },
            ],
          }))}
        />
      )}

      {formValues.monitoringEnabled && monitoringEvents.length === 0 && (
        <SectionMessage appearance="information" title="No events yet">
          <Text>
            No dispatch events have been recorded yet. Events will appear here
            after the dispatcher processes PR comments.
          </Text>
        </SectionMessage>
      )}
    </Stack>
  );
};

// Mount the component tree when this module is loaded by the Forge runtime.
// With `render: native` in manifest.yml, Forge loads this file directly as
// the frontend entry point rather than calling an exported function.
ForgeReconciler.render(
  <React.StrictMode>
    <SettingsForm />
  </React.StrictMode>,
);
