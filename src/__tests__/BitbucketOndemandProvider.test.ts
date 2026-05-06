import { BitbucketOndemandProvider } from '../providers/BitbucketOndemandProvider';
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
  return { ...DEFAULT_CONFIG, ciType: 'BITBUCKET_ONDEMAND', ...overrides };
}

function makeContext(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    workspaceUuid: '{ws-uuid}',
    repoUuid: '{repo-uuid}',
    projectUuid: '{proj-uuid}',
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

describe('BitbucketOndemandProvider', () => {
  beforeEach(() => mockRequestBitbucket.mockReset());

  describe('triggerBuild', () => {
    it('triggers an on-demand pipeline and returns a build URL derived from build_number', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ uuid: '{pipeline-uuid}', build_number: 42 }),
        text: async () => '',
      });

      const provider = new BitbucketOndemandProvider(makeConfig());
      const result = await provider.triggerBuild(makePayload(), makeContext());

      expect(result.success).toBe(true);
      expect(result.buildId).toBe('{pipeline-uuid}');
      expect(result.buildUrl).toBe(
        'https://bitbucket.org/my-workspace/spoke-repo/pipelines/results/42',
      );
      expect(mockRequestBitbucket).toHaveBeenCalledTimes(1);
    });

    it('sends Content-Type: application/yaml and the YAML body verbatim', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ uuid: '{u}', build_number: 1 }),
        text: async () => '',
      });

      const customYaml =
        'pipelines:\n  default:\n    - step:\n        script:\n          - echo "hi"\n';
      const provider = new BitbucketOndemandProvider(
        makeConfig({ ondemandYamlTemplate: customYaml }),
      );
      await provider.triggerBuild(makePayload(), makeContext());

      const init = mockRequestBitbucket.mock.calls[0][1];
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/yaml');
      expect(init.body).toBe(customYaml);
    });

    it('builds the URL with the spoke repo path and on-demand query string', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ uuid: '{u}', build_number: 1 }),
        text: async () => '',
      });

      const provider = new BitbucketOndemandProvider(makeConfig());
      await provider.triggerBuild(makePayload(), makeContext());

      const url = mockRequestBitbucket.mock.calls[0][0] as string;
      expect(url).toContain('/2.0/repositories/my-workspace/spoke-repo/pipelines/');
      expect(url).toContain('?');
      expect(url).toContain('target.ref_type=branch');
      // URLSearchParams encodes the branch slash as %2F.
      expect(url).toContain('target.ref_name=feature%2Fcool-stuff');
      expect(url).toContain('target.selector.type=default');
      expect(url).toContain('variables.SOURCE_WORKSPACE=my-workspace');
      expect(url).toContain('variables.PR_ID=7');
    });

    it('uses ondemandTargetRepo override when set', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ uuid: '{u}', build_number: 1 }),
        text: async () => '',
      });

      const provider = new BitbucketOndemandProvider(
        makeConfig({ ondemandTargetRepo: 'central-ws/runner' }),
      );
      await provider.triggerBuild(makePayload(), makeContext());

      const url = mockRequestBitbucket.mock.calls[0][0] as string;
      expect(url).toContain('/2.0/repositories/central-ws/runner/pipelines/');
    });

    it('uses ondemandTargetBranch override when set', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ uuid: '{u}', build_number: 1 }),
        text: async () => '',
      });

      const provider = new BitbucketOndemandProvider(
        makeConfig({ ondemandTargetBranch: 'main' }),
      );
      await provider.triggerBuild(makePayload(), makeContext());

      const url = mockRequestBitbucket.mock.calls[0][0] as string;
      expect(url).toContain('target.ref_name=main');
    });

    it('throws CIProviderError on a non-OK response with status code propagated', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => 'Invalid YAML',
      });

      const provider = new BitbucketOndemandProvider(makeConfig());

      try {
        await provider.triggerBuild(makePayload(), makeContext());
        fail('Expected CIProviderError');
      } catch (err) {
        expect(err).toBeInstanceOf(CIProviderError);
        expect((err as CIProviderError).statusCode).toBe(422);
        expect((err as CIProviderError).providerName).toBe(
          'Bitbucket Pipelines (on-demand)',
        );
      }
    });

    it('throws CIProviderError when the configured target repo is malformed', async () => {
      const provider = new BitbucketOndemandProvider(
        makeConfig({ ondemandTargetRepo: 'no-slash-here' }),
      );

      await expect(
        provider.triggerBuild(makePayload(), makeContext()),
      ).rejects.toThrow(CIProviderError);
      expect(mockRequestBitbucket).not.toHaveBeenCalled();
    });

    it('throws CIProviderError when the source branch contains unsafe characters', async () => {
      const provider = new BitbucketOndemandProvider(makeConfig());

      await expect(
        provider.triggerBuild(
          makePayload({ branch: 'evil?branch' }),
          makeContext({ sourceBranch: 'evil?branch' }),
        ),
      ).rejects.toThrow(CIProviderError);
      expect(mockRequestBitbucket).not.toHaveBeenCalled();
    });

    it('returns an undefined buildUrl when build_number is missing', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ uuid: '{u}' }),
        text: async () => '',
      });

      const provider = new BitbucketOndemandProvider(makeConfig());
      const result = await provider.triggerBuild(makePayload(), makeContext());

      expect(result.success).toBe(true);
      expect(result.buildUrl).toBeUndefined();
      expect(result.buildId).toBe('{u}');
    });

    it('wraps unexpected errors in CIProviderError', async () => {
      mockRequestBitbucket.mockRejectedValue(new Error('Network down'));

      const provider = new BitbucketOndemandProvider(makeConfig());

      await expect(
        provider.triggerBuild(makePayload(), makeContext()),
      ).rejects.toThrow(CIProviderError);
    });
  });

  describe('getBuildStatus', () => {
    it('throws CIProviderError when ondemandTargetRepo is empty', async () => {
      const provider = new BitbucketOndemandProvider(makeConfig());
      await expect(provider.getBuildStatus('build-id')).rejects.toThrow(CIProviderError);
      await expect(provider.getBuildStatus('build-id')).rejects.toThrow(
        /target repository must be configured/,
      );
    });

    it('returns the pipeline state name on success', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: true,
        json: async () => ({ state: { name: 'COMPLETED' } }),
        text: async () => '',
      });

      const provider = new BitbucketOndemandProvider(
        makeConfig({ ondemandTargetRepo: 'ws/repo' }),
      );

      const status = await provider.getBuildStatus('build-id');
      expect(status).toBe('COMPLETED');
    });

    it('throws CIProviderError on a non-OK response', async () => {
      mockRequestBitbucket.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const provider = new BitbucketOndemandProvider(
        makeConfig({ ondemandTargetRepo: 'ws/repo' }),
      );

      await expect(provider.getBuildStatus('bad-id')).rejects.toThrow(CIProviderError);
    });

    it('throws CIProviderError when the configured target repo is malformed', async () => {
      const provider = new BitbucketOndemandProvider(
        makeConfig({ ondemandTargetRepo: 'no-slash' }),
      );
      await expect(provider.getBuildStatus('build-id')).rejects.toThrow(CIProviderError);
    });
  });
});
