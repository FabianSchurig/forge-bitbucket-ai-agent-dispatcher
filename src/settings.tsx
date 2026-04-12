import React, { useState, useEffect } from 'react';
import ForgeReconciler, {
  Button,
  DynamicTable,
  Form,
  FormSection,
  Label,
  Lozenge,
  SectionMessage,
  Stack,
  Heading,
  Textfield,
  Text,
  Select,
  Toggle,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';
import { AppConfig, DEFAULT_CONFIG } from './types';
import type { DispatchEvent } from './types';
import type { CIProviderType } from './interfaces/CIProvider';

// The InputEvent type from Forge UI Kit 2 is a serialisable event object (not
// the standard DOM Event). Only target.value is needed here.
type ForgeInputEvent = { target: { value?: unknown } };

// Select change events deliver the selected option value directly.
type ForgeSelectEvent = { value: string; label: string };

/** Available CI provider options for the dropdown. */
const CI_PROVIDER_OPTIONS: Array<{ label: string; value: CIProviderType }> = [
  { label: 'Bitbucket Pipelines', value: 'BITBUCKET_PIPELINES' },
  { label: 'Jenkins', value: 'JENKINS' },
];

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
        setFormValues(data ?? DEFAULT_CONFIG);

        // Load monitoring events (best-effort — errors are silently ignored).
        try {
          const events = await invoke<DispatchEvent[]>('getMonitoringEvents', {});
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
  const isJenkins = formValues.ciType === 'JENKINS';

  return (
    <Stack space="space.200">
      <Heading as="h2">AI Agent Dispatcher Settings</Heading>

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

          <Label labelFor="ciType">CI/CD Provider</Label>
          <Select
            inputId="ciType"
            name="ciType"
            options={CI_PROVIDER_OPTIONS}
            value={CI_PROVIDER_OPTIONS.find((o) => o.value === formValues.ciType)}
            onChange={handleCiTypeChange}
          />
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

            <Label labelFor="hubRepository">Hub Repository Slug</Label>
            <Textfield
              id="hubRepository"
              name="hubRepository"
              value={formValues.hubRepository}
              placeholder="ai-agent-hub"
              onChange={handleChange('hubRepository')}
            />

            <Label labelFor="hubPipeline">Hub Pipeline Name</Label>
            <Textfield
              id="hubPipeline"
              name="hubPipeline"
              value={formValues.hubPipeline}
              placeholder="custom: run-agent-session"
              onChange={handleChange('hubPipeline')}
            />

            <Label labelFor="pipelineBranch">Pipeline Branch Name</Label>
            <Textfield
              id="pipelineBranch"
              name="pipelineBranch"
              value={formValues.pipelineBranch}
              placeholder="main"
              onChange={handleChange('pipelineBranch')}
            />
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

            <Label labelFor="jenkinsJobPath">Jenkins Job Path</Label>
            <Textfield
              id="jenkinsJobPath"
              name="jenkinsJobPath"
              value={formValues.jenkinsJobPath}
              placeholder="job/my-folder/job/my-job"
              onChange={handleChange('jenkinsJobPath')}
            />

            <SectionMessage appearance="warning" title="Security Notice">
              <Text>
                Jenkins API tokens are stored using Forge Encrypted Storage and are never visible in plain text.
                Use the Forge CLI to set the token: forge storage set-secret --key jenkins-api-token --value YOUR_BASE64_TOKEN
                The token value should be a Base64-encoded username:apiToken string.
              </Text>
            </SectionMessage>
          </FormSection>
        )}

        <Button type="submit" appearance="primary">
          Save Settings
        </Button>
      </Form>

      {/* Monitoring section — shows recent dispatch events when enabled. */}
      <Heading as="h2">Monitoring</Heading>

      <FormSection>
        <Label labelFor="monitoringEnabled">Enable Monitoring</Label>
        <Toggle
          id="monitoringEnabled"
          isChecked={formValues.monitoringEnabled}
          onChange={handleMonitoringToggle}
        />
        <Text>
          When enabled, the dispatcher records each event (success, failure, skipped) for review here.
        </Text>
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
