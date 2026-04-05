import React from 'react';
import ForgeReconciler, {
  Button,
  Form,
  FormSection,
  Label,
  SectionMessage,
  Stack,
  Heading,
  TextField,
  Text,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { AppConfig, DEFAULT_CONFIG } from './types';

export const SettingsForm: React.FC = () => {
  const [config, setConfig] = React.useState<AppConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  React.useEffect(() => {
    invoke<AppConfig>('getSettings')
      .then((data) => {
        setConfig(data ?? DEFAULT_CONFIG);
        setLoading(false);
      })
      .catch((err: unknown) => {
        console.error('Failed to load settings:', err);
        setLoading(false);
        setErrorMsg('Failed to load settings. Showing defaults.');
      });
  }, []);

  const handleSubmit = async (formData: Record<string, string>): Promise<void> => {
    setSaved(false);
    setErrorMsg(null);

    try {
      const newConfig: AppConfig = {
        triggerKeyword: formData['triggerKeyword'] || DEFAULT_CONFIG.triggerKeyword,
        hubWorkspace: formData['hubWorkspace'] ?? '',
        hubRepository: formData['hubRepository'] || DEFAULT_CONFIG.hubRepository,
        hubPipeline: formData['hubPipeline'] || DEFAULT_CONFIG.hubPipeline,
        pipelineBranch: formData['pipelineBranch'] || DEFAULT_CONFIG.pipelineBranch,
      };

      await invoke('saveSettings', newConfig);
      setConfig(newConfig);
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
      <Heading size="large">AI Agent Dispatcher Settings</Heading>

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
          <TextField
            id="triggerKeyword"
            name="triggerKeyword"
            defaultValue={config.triggerKeyword}
            placeholder="@agent"
          />

          <Label labelFor="hubWorkspace">Hub Workspace Slug</Label>
          <TextField
            id="hubWorkspace"
            name="hubWorkspace"
            defaultValue={config.hubWorkspace}
            placeholder="Leave blank to use the current workspace"
          />

          <Label labelFor="hubRepository">Hub Repository Slug</Label>
          <TextField
            id="hubRepository"
            name="hubRepository"
            defaultValue={config.hubRepository}
            placeholder="ai-agent-hub"
          />

          <Label labelFor="hubPipeline">Hub Pipeline Name</Label>
          <TextField
            id="hubPipeline"
            name="hubPipeline"
            defaultValue={config.hubPipeline}
            placeholder="custom: run-agent-session"
          />

          <Label labelFor="pipelineBranch">Pipeline Branch Name</Label>
          <TextField
            id="pipelineBranch"
            name="pipelineBranch"
            defaultValue={config.pipelineBranch}
            placeholder="main"
          />
        </FormSection>

        <Button type="submit" appearance="primary">
          Save Settings
        </Button>
      </Form>
    </Stack>
  );
};

/**
 * Forge UI Kit 2 renderer handler.
 * The manifest.yml function handler points to this export.
 * When Forge invokes it, it mounts the React component tree.
 */
export function renderSettings(): void {
  ForgeReconciler.render(
    <React.StrictMode>
      <SettingsForm />
    </React.StrictMode>,
  );
}
