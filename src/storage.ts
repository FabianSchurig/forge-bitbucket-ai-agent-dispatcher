import kvs from '@forge/kvs';
import { AppConfig, DEFAULT_CONFIG } from './types';

const STORAGE_KEY = 'appConfig';

/**
 * Retrieves the current app configuration from Forge Storage.
 * Missing fields are filled in from DEFAULT_CONFIG so callers always
 * receive a fully-populated object.
 */
export async function getSettings(): Promise<AppConfig> {
  const stored = (await kvs.get<AppConfig>(STORAGE_KEY)) as AppConfig | undefined;
  if (!stored) {
    return { ...DEFAULT_CONFIG };
  }
  return { ...DEFAULT_CONFIG, ...stored };
}

/**
 * Persists a (partial) app configuration to Forge Storage.
 * The supplied values are merged on top of the existing persisted values.
 */
export async function saveSettings(config: Partial<AppConfig>): Promise<void> {
  const current = await getSettings();
  const updated: AppConfig = { ...current, ...config };
  await kvs.set(STORAGE_KEY, updated);
}
