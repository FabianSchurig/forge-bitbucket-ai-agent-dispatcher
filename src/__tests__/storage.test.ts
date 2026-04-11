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
// getSettings — legacy (no projectUuid)
// ---------------------------------------------------------------------------

describe('getSettings (legacy global key)', () => {
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

  it('reads from the legacy storage key when no project UUID', async () => {
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
// getSettings — project-scoped
// ---------------------------------------------------------------------------

describe('getSettings (project-scoped)', () => {
  beforeEach(() => {
    mockStorageGet.mockReset();
    mockStorageSet.mockReset();
  });

  it('reads from the project-scoped key when projectUuid is provided', async () => {
    mockStorageGet.mockResolvedValue(undefined);

    await getSettings('{proj-uuid}');

    // Should try project-scoped key then fall back to legacy
    expect(mockStorageGet).toHaveBeenCalledWith('dispatch-config-{proj-uuid}');
    expect(mockStorageGet).toHaveBeenCalledWith('appConfig');
  });

  it('returns project-scoped config when it exists', async () => {
    mockStorageGet.mockImplementation(async (key: string) => {
      if (key === 'dispatch-config-{proj-uuid}') {
        return { triggerKeyword: '!project-bot', hubRepository: 'project-hub' };
      }
      return undefined;
    });

    const config = await getSettings('{proj-uuid}');

    expect(config.triggerKeyword).toBe('!project-bot');
    expect(config.hubRepository).toBe('project-hub');
  });

  it('falls back to legacy key when project-scoped config is empty', async () => {
    mockStorageGet.mockImplementation(async (key: string) => {
      if (key === 'appConfig') {
        return { triggerKeyword: '!legacy' };
      }
      return undefined;
    });

    const config = await getSettings('{proj-uuid}');

    expect(config.triggerKeyword).toBe('!legacy');
  });

  it('prefers repo-level override over project-level config', async () => {
    mockStorageGet.mockImplementation(async (key: string) => {
      if (key === 'dispatch-config-repo-{repo-uuid}') {
        return { triggerKeyword: '!repo-override' };
      }
      if (key === 'dispatch-config-{proj-uuid}') {
        return { triggerKeyword: '!project-config' };
      }
      return undefined;
    });

    const config = await getSettings('{proj-uuid}', '{repo-uuid}');

    expect(config.triggerKeyword).toBe('!repo-override');
  });

  it('falls back to project config when repo-level is empty', async () => {
    mockStorageGet.mockImplementation(async (key: string) => {
      if (key === 'dispatch-config-{proj-uuid}') {
        return { triggerKeyword: '!project-config' };
      }
      return undefined;
    });

    const config = await getSettings('{proj-uuid}', '{repo-uuid}');

    expect(config.triggerKeyword).toBe('!project-config');
  });
});

// ---------------------------------------------------------------------------
// saveSettings — legacy (no projectUuid)
// ---------------------------------------------------------------------------

describe('saveSettings (legacy global key)', () => {
  beforeEach(() => {
    mockStorageGet.mockReset();
    mockStorageSet.mockReset();
    mockStorageGet.mockResolvedValue(undefined);
    mockStorageSet.mockResolvedValue(undefined);
  });

  it('writes the merged config to legacy storage key', async () => {
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
      ciType: 'BITBUCKET_PIPELINES' as const,
      hubWorkspace: 'central',
      hubRepository: 'hub-repo',
      hubPipeline: 'custom: run-ai',
      pipelineBranch: 'develop',
      jenkinsUrl: '',
      jenkinsJobPath: '',
    };

    await saveSettings(newConfig);

    expect(mockStorageSet).toHaveBeenCalledWith('appConfig', newConfig);
  });

  it('writes to the legacy storage key when no projectUuid', async () => {
    await saveSettings({});

    const [key] = mockStorageSet.mock.calls[0] as [string, unknown];
    expect(key).toBe('appConfig');
  });
});

// ---------------------------------------------------------------------------
// saveSettings — project-scoped
// ---------------------------------------------------------------------------

describe('saveSettings (project-scoped)', () => {
  beforeEach(() => {
    mockStorageGet.mockReset();
    mockStorageSet.mockReset();
    mockStorageGet.mockResolvedValue(undefined);
    mockStorageSet.mockResolvedValue(undefined);
  });

  it('writes to the project-scoped key when projectUuid is provided', async () => {
    await saveSettings({ triggerKeyword: '!project' }, '{proj-uuid}');

    const [key] = mockStorageSet.mock.calls[0] as [string, unknown];
    expect(key).toBe('dispatch-config-{proj-uuid}');
  });

  it('merges partial updates into project-scoped config', async () => {
    mockStorageGet.mockImplementation(async (key: string) => {
      if (key === 'dispatch-config-{proj-uuid}') {
        return { ...DEFAULT_CONFIG, triggerKeyword: '!existing' };
      }
      return undefined;
    });

    await saveSettings({ hubRepository: 'new-hub' }, '{proj-uuid}');

    expect(mockStorageSet).toHaveBeenCalledWith('dispatch-config-{proj-uuid}', {
      ...DEFAULT_CONFIG,
      triggerKeyword: '!existing',
      hubRepository: 'new-hub',
    });
  });
});
