import Resolver from '@forge/resolver';
import { getSettings, saveSettings } from './storage';
import { AppConfig } from './types';

const resolver = new Resolver();

resolver.define('getSettings', async (): Promise<AppConfig> => {
  return await getSettings();
});

resolver.define('saveSettings', async ({ payload }: { payload: AppConfig }) => {
  await saveSettings(payload);
  return { success: true };
});

/** Resolver handler exported for use in manifest.yml. */
export const handler = resolver.getDefinitions();
