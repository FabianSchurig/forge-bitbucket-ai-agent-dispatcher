/**
 * Tests for the compile-time JENKINS_ENABLED feature flag.
 *
 * The flag is a plain `const` exported from src/featureFlags.ts. The `lite`
 * release variant flips it to `false` by rewriting the file with `sed`
 * before bundling, so these tests use jest.isolateModules + jest.doMock to
 * simulate both compile-time states without touching the source on disk.
 */

// The mocks below need to be in place before the modules under test are
// require()-d inside jest.isolateModules, so we install @forge/kvs and
// @forge/api mocks at the top level — the same approach the existing
// ProviderFactory tests use.

jest.mock('@forge/kvs', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
    getSecret: jest.fn().mockResolvedValue('dGVzdDp0b2tlbg=='),
    setSecret: jest.fn().mockResolvedValue(undefined),
    deleteSecret: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: {
    asApp: jest.fn().mockReturnValue({ requestBitbucket: jest.fn() }),
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

describe('JENKINS_ENABLED feature flag', () => {
  // The DEFAULT_CONFIG is imported lazily inside each test so that it picks
  // up the same module graph as the ProviderFactory under test.

  describe('when JENKINS_ENABLED is true (full build)', () => {
    it('lets ProviderFactory build a JenkinsProvider', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../featureFlags', () => ({
          __esModule: true,
          JENKINS_ENABLED: true,
        }));

        // Stub storage so getSettings returns a Jenkins-shaped config.
        const { DEFAULT_CONFIG } = await import('../types');
        jest.doMock('../storage', () => ({
          __esModule: true,
          getSettings: jest.fn().mockResolvedValue({
            ...DEFAULT_CONFIG,
            ciType: 'JENKINS',
            jenkinsUrl: 'https://jenkins.example.com',
            jenkinsJobPath: 'job/my-job',
          }),
        }));

        const { ProviderFactory } = await import('../factories/ProviderFactory');
        const { JenkinsProvider } = await import('../providers/JenkinsProvider');

        const provider = await ProviderFactory.getProvider('proj-uuid');
        expect(provider).toBeInstanceOf(JenkinsProvider);
      });
    });
  });

  describe('when JENKINS_ENABLED is false (lite build)', () => {
    it('makes ProviderFactory refuse to build a JenkinsProvider', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../featureFlags', () => ({
          __esModule: true,
          JENKINS_ENABLED: false,
        }));

        const { DEFAULT_CONFIG } = await import('../types');
        jest.doMock('../storage', () => ({
          __esModule: true,
          getSettings: jest.fn().mockResolvedValue({
            ...DEFAULT_CONFIG,
            ciType: 'JENKINS',
            jenkinsUrl: 'https://jenkins.example.com',
            jenkinsJobPath: 'job/my-job',
          }),
        }));

        const { ProviderFactory } = await import('../factories/ProviderFactory');
        const { CIProviderError } = await import('../interfaces/CIProviderError');

        // The factory must throw *before* reaching the kvs.getSecret call.
        await expect(ProviderFactory.getProvider('proj-uuid')).rejects.toBeInstanceOf(
          CIProviderError,
        );
        await expect(ProviderFactory.getProvider('proj-uuid')).rejects.toThrow(
          /not available in this build/i,
        );
      });
    });

    it('does not affect Bitbucket Pipelines providers', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../featureFlags', () => ({
          __esModule: true,
          JENKINS_ENABLED: false,
        }));

        const { DEFAULT_CONFIG } = await import('../types');
        jest.doMock('../storage', () => ({
          __esModule: true,
          getSettings: jest.fn().mockResolvedValue({
            ...DEFAULT_CONFIG,
            ciType: 'BITBUCKET_PIPELINES',
          }),
        }));

        const { ProviderFactory } = await import('../factories/ProviderFactory');
        const { BitbucketPipelinesProvider } = await import(
          '../providers/BitbucketPipelinesProvider'
        );

        const provider = await ProviderFactory.getProvider('proj-uuid');
        expect(provider).toBeInstanceOf(BitbucketPipelinesProvider);
      });
    });
  });
});
