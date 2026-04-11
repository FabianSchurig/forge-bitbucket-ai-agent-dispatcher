import { ProviderFactory } from '../factories/ProviderFactory';
import { BitbucketPipelinesProvider } from '../providers/BitbucketPipelinesProvider';
import { JenkinsProvider } from '../providers/JenkinsProvider';
import { CIProviderError } from '../interfaces/CIProviderError';
import { DEFAULT_CONFIG } from '../types';

// ---------------------------------------------------------------------------
// Mock @forge/kvs (used by storage.ts which ProviderFactory depends on)
// ---------------------------------------------------------------------------

jest.mock('@forge/kvs', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Mock @forge/api
// ---------------------------------------------------------------------------

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: {
    asApp: jest.fn().mockReturnValue({
      requestBitbucket: jest.fn(),
    }),
    fetch: jest.fn(),
  },
  storage: {
    get: jest.fn(),
    set: jest.fn(),
    getSecret: jest.fn(),
    setSecret: jest.fn(),
  },
  route: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? String(values[i]) : ''),
      '',
    ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kvsMock = jest.requireMock('@forge/kvs') as any;
const mockKvsGet: jest.Mock = kvsMock.default.get;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const forgeApiMock = jest.requireMock('@forge/api') as any;
const mockGetSecret: jest.Mock = forgeApiMock.storage.getSecret;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProviderFactory', () => {
  beforeEach(() => {
    mockKvsGet.mockReset();
    mockGetSecret.mockReset();
    // Default: storage returns no stored config (uses defaults).
    mockKvsGet.mockResolvedValue(undefined);
  });

  it('returns a BitbucketPipelinesProvider when ciType is BITBUCKET_PIPELINES', async () => {
    // DEFAULT_CONFIG.ciType is 'BITBUCKET_PIPELINES'
    const provider = await ProviderFactory.getProvider();
    expect(provider).toBeInstanceOf(BitbucketPipelinesProvider);
  });

  it('returns a BitbucketPipelinesProvider when no config is stored (defaults)', async () => {
    mockKvsGet.mockResolvedValue(undefined);
    const provider = await ProviderFactory.getProvider();
    expect(provider).toBeInstanceOf(BitbucketPipelinesProvider);
  });

  it('returns a JenkinsProvider when ciType is JENKINS and all config is present', async () => {
    mockKvsGet.mockResolvedValue({
      ...DEFAULT_CONFIG,
      ciType: 'JENKINS',
      jenkinsUrl: 'https://jenkins.example.com',
      jenkinsJobPath: 'job/my-job',
    });
    mockGetSecret.mockResolvedValue('my-secret-token');

    const provider = await ProviderFactory.getProvider();
    expect(provider).toBeInstanceOf(JenkinsProvider);
  });

  it('throws CIProviderError when ciType is JENKINS but no API token is stored', async () => {
    mockKvsGet.mockResolvedValue({
      ...DEFAULT_CONFIG,
      ciType: 'JENKINS',
      jenkinsUrl: 'https://jenkins.example.com',
      jenkinsJobPath: 'job/my-job',
    });
    mockGetSecret.mockResolvedValue(undefined);

    await expect(ProviderFactory.getProvider()).rejects.toThrow(CIProviderError);
    await expect(ProviderFactory.getProvider()).rejects.toThrow(/No API token configured/);
  });

  it('throws CIProviderError when ciType is JENKINS but jenkinsUrl is empty', async () => {
    mockKvsGet.mockResolvedValue({
      ...DEFAULT_CONFIG,
      ciType: 'JENKINS',
      jenkinsUrl: '',
      jenkinsJobPath: 'job/my-job',
    });
    mockGetSecret.mockResolvedValue('my-secret-token');

    await expect(ProviderFactory.getProvider()).rejects.toThrow(CIProviderError);
    await expect(ProviderFactory.getProvider()).rejects.toThrow(/No Jenkins URL configured/);
  });

  it('throws CIProviderError for an unsupported ciType', async () => {
    mockKvsGet.mockResolvedValue({
      ...DEFAULT_CONFIG,
      ciType: 'GITHUB_ACTIONS', // not yet supported
    });

    await expect(ProviderFactory.getProvider()).rejects.toThrow(CIProviderError);
    await expect(ProviderFactory.getProvider()).rejects.toThrow(/Unsupported CI provider type/);
  });

  it('retrieves the Jenkins token from encrypted storage', async () => {
    mockKvsGet.mockResolvedValue({
      ...DEFAULT_CONFIG,
      ciType: 'JENKINS',
      jenkinsUrl: 'https://jenkins.example.com',
      jenkinsJobPath: 'job/my-job',
    });
    mockGetSecret.mockResolvedValue('encrypted-token-value');

    await ProviderFactory.getProvider();

    expect(mockGetSecret).toHaveBeenCalledWith('jenkins-api-token');
  });
});
