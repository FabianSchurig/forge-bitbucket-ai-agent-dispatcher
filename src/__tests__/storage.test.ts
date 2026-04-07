import { getSettings, saveSettings } from '../storage';
import { DEFAULT_CONFIG } from '../types';

// ---------------------------------------------------------------------------
// Mock @forge/kvs
// ---------------------------------------------------------------------------

jest.mock('@forge/kvs', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
  },
}));

// Retrieve stable references to the mock functions after the factory has run.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kvsM = jest.requireMock('@forge/kvs') as any;
const mockStorageGet: jest.Mock = kvsM.default.get;
const mockStorageSet: jest.Mock = kvsM.default.set;

// ---------------------------------------------------------------------------
// getSettings
// ---------------------------------------------------------------------------

describe('getSettings', () => {
  beforeEach(() => {
    mockStorageGet.mockReset();
    mockStorageSet.mockReset();
  });

  it('returns DEFAULT_CONFIG when nothing is stored', async () => {
    mockStorageGet.mockResolvedValue(undefined);

    const config = await getSettings();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('returns the stored config merged with defaults', async () => {
    mockStorageGet.mockResolvedValue({
      triggerKeyword: '!bot',
      hubRepository: 'custom-hub',
    });

    const config = await getSettings();

    expect(config.triggerKeyword).toBe('!bot');
    expect(config.hubRepository).toBe('custom-hub');
    // Fields not in stored config fall back to defaults.
    expect(config.hubPipeline).toBe(DEFAULT_CONFIG.hubPipeline);
    expect(config.pipelineBranch).toBe(DEFAULT_CONFIG.pipelineBranch);
  });

  it('reads from the correct storage key', async () => {
    mockStorageGet.mockResolvedValue(undefined);

    await getSettings();

    expect(mockStorageGet).toHaveBeenCalledWith('appConfig');
  });

  it('returns a copy of defaults, not the original object', async () => {
    mockStorageGet.mockResolvedValue(undefined);

    const config = await getSettings();
    config.triggerKeyword = 'mutated';

    const config2 = await getSettings();
    expect(config2.triggerKeyword).toBe(DEFAULT_CONFIG.triggerKeyword);
  });
});

// ---------------------------------------------------------------------------
// saveSettings
// ---------------------------------------------------------------------------

describe('saveSettings', () => {
  beforeEach(() => {
    mockStorageGet.mockReset();
    mockStorageSet.mockReset();
    mockStorageGet.mockResolvedValue(undefined);
    mockStorageSet.mockResolvedValue(undefined);
  });

  it('writes the merged config to storage', async () => {
    await saveSettings({ triggerKeyword: '!ai', hubRepository: 'my-hub' });

    expect(mockStorageSet).toHaveBeenCalledWith('appConfig', {
      ...DEFAULT_CONFIG,
      triggerKeyword: '!ai',
      hubRepository: 'my-hub',
    });
  });

  it('merges partial updates on top of existing persisted values', async () => {
    mockStorageGet.mockResolvedValue({
      ...DEFAULT_CONFIG,
      triggerKeyword: '!bot',
      hubWorkspace: 'existing-ws',
    });

    await saveSettings({ hubRepository: 'new-hub' });

    expect(mockStorageSet).toHaveBeenCalledWith('appConfig', {
      ...DEFAULT_CONFIG,
      triggerKeyword: '!bot',
      hubWorkspace: 'existing-ws',
      hubRepository: 'new-hub',
    });
  });

  it('persists a full config update', async () => {
    const newConfig = {
      triggerKeyword: '/agent',
      hubWorkspace: 'central',
      hubRepository: 'hub-repo',
      hubPipeline: 'custom: run-ai',
      pipelineBranch: 'develop',
    };

    await saveSettings(newConfig);

    expect(mockStorageSet).toHaveBeenCalledWith('appConfig', newConfig);
  });

  it('writes to the correct storage key', async () => {
    await saveSettings({});

    const [key] = mockStorageSet.mock.calls[0] as [string, unknown];
    expect(key).toBe('appConfig');
  });
});
