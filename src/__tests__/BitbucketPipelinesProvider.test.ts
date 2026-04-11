import { BitbucketPipelinesProvider } from '../providers/BitbucketPipelinesProvider';
import { CIProviderError } from '../interfaces/CIProviderError';
import { DEFAULT_CONFIG } from '../types';
import type { AppConfig, DispatchContext } from '../types';
import type { BuildPayload } from '../interfaces/CIProvider';

// ---------------------------------------------------------------------------
// Mock @forge/api
// ---------------------------------------------------------------------------

jest.mock('@forge/api', () => ({
  __esModule: true,
  default: {
    asApp: jest.fn().mockReturnValue({
      requestBitbucket: jest.fn(),
    }),
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
const forgeApiMock = jest.requireMock('@forge/api') as any;
const mockRequestBitbucket: jest.Mock = forgeApiMock.default.asApp().requestBitbucket;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function makeContext(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    workspaceUuid: '{ws-uuid-5678}',
    repoUuid: '{repo-uuid-1234}',
    projectUuid: '{proj-uuid-9999}',
    workspace: 'my-workspace',
    repoSlug: 'spoke-repo',
    prId: 7,
    sourceBranch: 'feature/cool-stuff',
    commentText: '@agent do something',
    commentAuthor: 'user-123',
    commentId: 42,
    ...overrides,
  };
}

function makePayload(overrides: Partial<BuildPayload> = {}): BuildPayload {
  return {
    branch: 'feature/cool-stuff',
    repoName: 'spoke-repo',
    workspace: 'my-workspace',
    prId: 7,
    commentText: '@agent do something',
    commentAuthor: 'user-123',
    commentId: 42,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BitbucketPipelinesProvider', () => {
  beforeEach(() => mockRequestBitbucket.mockReset());

  // -- triggerBuild --------------------------------------------------------

  describe('triggerBuild', () => {
    it('triggers a pipeline and returns a success result', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '',
      });

      const provider = new BitbucketPipelinesProvider(makeConfig());
      const result = await provider.triggerBuild(makePayload(), makeContext());

      expect(result.success).toBe(true);
      expect(result.message).toContain('Pipeline triggered');
      expect(mockRequestBitbucket).toHaveBeenCalledTimes(1);
    });

    it('uses the hubWorkspace from config when set', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '',
      });

      const config = makeConfig({ hubWorkspace: 'central-ws' });
      const provider = new BitbucketPipelinesProvider(config);
      await provider.triggerBuild(makePayload(), makeContext());

      const calledUrl = mockRequestBitbucket.mock.calls[0][0] as string;
      expect(calledUrl).toContain('central-ws');
    });

    it('falls back to payload workspace when hubWorkspace is empty', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '',
      });

      const config = makeConfig({ hubWorkspace: '' });
      const provider = new BitbucketPipelinesProvider(config);
      await provider.triggerBuild(
        makePayload({ workspace: 'spoke-ws' }),
        makeContext(),
      );

      const calledUrl = mockRequestBitbucket.mock.calls[0][0] as string;
      expect(calledUrl).toContain('spoke-ws');
    });

    it('strips the "custom: " prefix from the pipeline name', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '',
      });

      const provider = new BitbucketPipelinesProvider(makeConfig());
      await provider.triggerBuild(makePayload(), makeContext());

      const body = JSON.parse(
        mockRequestBitbucket.mock.calls[0][1].body as string,
      );
      expect(body.target.selector.pattern).toBe('run-agent-session');
    });

    it('sends all six pipeline variables', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '',
      });

      const provider = new BitbucketPipelinesProvider(makeConfig());
      await provider.triggerBuild(makePayload(), makeContext());

      const body = JSON.parse(
        mockRequestBitbucket.mock.calls[0][1].body as string,
      );
      const keys = body.variables.map(
        (v: { key: string }) => v.key,
      );
      expect(keys).toEqual([
        'SOURCE_WORKSPACE',
        'SOURCE_REPO',
        'PR_ID',
        'SOURCE_BRANCH',
        'COMMENT_TEXT',
        'COMMENT_AUTHOR',
      ]);
    });

    it('throws CIProviderError on a non-OK response', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const provider = new BitbucketPipelinesProvider(makeConfig());

      await expect(
        provider.triggerBuild(makePayload(), makeContext()),
      ).rejects.toThrow(CIProviderError);
    });

    it('includes the HTTP status in the CIProviderError', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      const provider = new BitbucketPipelinesProvider(makeConfig());

      try {
        await provider.triggerBuild(makePayload(), makeContext());
        fail('Expected CIProviderError');
      } catch (err) {
        expect(err).toBeInstanceOf(CIProviderError);
        expect((err as CIProviderError).statusCode).toBe(403);
        expect((err as CIProviderError).providerName).toBe('Bitbucket Pipelines');
      }
    });

    it('wraps unexpected errors in CIProviderError', async () => {
      mockRequestBitbucket.mockRejectedValue(new Error('Network timeout'));

      const provider = new BitbucketPipelinesProvider(makeConfig());

      await expect(
        provider.triggerBuild(makePayload(), makeContext()),
      ).rejects.toThrow(CIProviderError);

      try {
        await provider.triggerBuild(makePayload(), makeContext());
      } catch (err) {
        expect((err as CIProviderError).message).toContain('Network timeout');
      }
    });
  });

  // -- getBuildStatus ------------------------------------------------------

  describe('getBuildStatus', () => {
    it('returns the pipeline state name on success', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        json: async () => ({ state: { name: 'COMPLETED' } }),
        text: async () => '',
      });

      const provider = new BitbucketPipelinesProvider(makeConfig({ hubWorkspace: 'my-ws' }));
      const status = await provider.getBuildStatus('build-123');

      expect(status).toBe('COMPLETED');
    });

    it('returns "UNKNOWN" when state is missing', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        json: async () => ({}),
        text: async () => '',
      });

      const provider = new BitbucketPipelinesProvider(makeConfig({ hubWorkspace: 'my-ws' }));
      const status = await provider.getBuildStatus('build-123');

      expect(status).toBe('UNKNOWN');
    });

    it('throws CIProviderError on a non-OK response', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const provider = new BitbucketPipelinesProvider(makeConfig({ hubWorkspace: 'my-ws' }));

      await expect(provider.getBuildStatus('bad-id')).rejects.toThrow(CIProviderError);
    });

    it('throws CIProviderError when hubWorkspace is empty', async () => {
      const provider = new BitbucketPipelinesProvider(makeConfig({ hubWorkspace: '' }));

      await expect(provider.getBuildStatus('build-123')).rejects.toThrow(CIProviderError);
      await expect(provider.getBuildStatus('build-123')).rejects.toThrow(
        /Hub workspace must be configured/,
      );
    });
  });
});
