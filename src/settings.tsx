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
import { invoke } from '@forge/bridge';
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

  useEffect(() => {
    invoke<AppConfig>('getSettings')
      .then((data) => {
        setFormValues(data ?? DEFAULT_CONFIG);
        setLoading(false);
      })
      .catch((err: unknown) => {
        console.error('Failed to load settings:', err);
        setLoading(false);
        setErrorMsg('Failed to load settings. Showing defaults.');
      });
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

    try {
      await invoke('saveSettings', formValues);
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
                Use the Forge CLI to set the token: forge storage:set-secret jenkins-api-token YOUR_TOKEN
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
