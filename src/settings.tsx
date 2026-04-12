import React, { useState, useEffect } from 'react';
import ForgeReconciler, {
  Button,
  Form,
  FormSection,
  Label,
  SectionMessage,
  Stack,
  Heading,
  Textfield,
  Text,
  Select,
} from '@forge/react';
import { invoke, view, permissions } from '@forge/bridge';
import { EgressType } from '@forge/egress';
import { AppConfig, DEFAULT_CONFIG } from './types';
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

  // Form onSubmit must match `() => Promise<void | boolean> | void` (no args).
  const handleSubmit = async (): Promise<void> => {
    setSaved(false);
    setErrorMsg(null);

    // When Jenkins is selected and a URL has been provided, we must request
    // Customer-Managed Egress permission for that specific domain before saving.
    // This triggers a native Atlassian modal asking the workspace admin to
    // approve the outbound connection.  Only workspace administrators can grant
    // this; if the call is rejected (denied or user lacks permission) we show
    // a helpful message and abort the save.
    if (formValues.ciType === 'JENKINS' && formValues.jenkinsUrl) {
      try {
        // Extract just the hostname (e.g. "jenkins.example.com") from the URL
        // so we request the narrowest possible egress scope.
        let hostname: string;
        try {
          hostname = new URL(formValues.jenkinsUrl).hostname;
          if (!hostname) {
            throw new Error('empty hostname');
          }
        } catch {
          setErrorMsg(
            'Invalid Jenkins URL format. Please enter a valid URL (e.g., https://jenkins.example.com).',
          );
          return;
        }

        await permissions.egress.set({
          egresses: [
            {
              // A stable identifier for this egress group; used as a storage key
              // by the Forge platform.
              key: 'jenkins-instance',
              description: 'Jenkins CI server for AI Agent Dispatcher',
              configured: [
                {
                  domain: hostname,
                  // FetchBackendSide means Forge's server-side proxy makes the
                  // outbound HTTP request on behalf of the app backend.
                  type: [EgressType.FetchBackendSide],
                },
              ],
            },
          ],
        });
      } catch (egressErr: unknown) {
        // The egress set() rejects when the user is not a workspace admin, or
        // when the admin clicks "Deny" in the consent modal.
        console.error('Egress permission request failed or was denied:', egressErr);
        setErrorMsg(
          'Jenkins URL approval failed. Please ensure you are a Workspace Administrator ' +
          'and approve the URL in the consent dialog.',
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

            <SectionMessage appearance="info" title="Egress Permission Required">
              <Text>
                Saving a Jenkins URL triggers an Atlassian approval dialog that allows the app to
                connect to your Jenkins server. Only Workspace Administrators can approve this request.
                If you are not an admin, ask your workspace administrator to save these settings.
              </Text>
            </SectionMessage>
          </FormSection>
        )}

        <Button type="submit" appearance="primary">
          Save Settings
        </Button>
      </Form>
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
