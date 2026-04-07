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
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { AppConfig, DEFAULT_CONFIG } from './types';

// The InputEvent type from Forge UI Kit 2 is a serialisable event object (not
// the standard DOM Event). Only target.value is needed here.
type ForgeInputEvent = { target: { value?: unknown } };

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

  // Helper to update a single field in formValues state.
  const handleChange =
    (field: keyof AppConfig) =>
    (e: ForgeInputEvent): void => {
      setFormValues((prev: AppConfig) => ({ ...prev, [field]: String(e.target.value ?? '') }));
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
