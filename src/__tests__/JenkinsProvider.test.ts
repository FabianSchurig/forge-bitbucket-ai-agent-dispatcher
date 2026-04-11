import { JenkinsProvider } from '../providers/JenkinsProvider';
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
const forgeApiMock = jest.requireMock('@forge/api') as any;
const mockFetch: jest.Mock = forgeApiMock.default.fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ciType: 'JENKINS',
    jenkinsUrl: 'https://jenkins.example.com',
    jenkinsJobPath: 'job/my-folder/job/my-job',
    ...overrides,
  };
}

function makeContext(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    workspaceUuid: '{ws-uuid-5678}',
    repoUuid: '{repo-uuid-1234}',
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JenkinsProvider', () => {
  beforeEach(() => mockFetch.mockReset());

  // -- triggerBuild --------------------------------------------------------

  describe('triggerBuild', () => {
    it('triggers a Jenkins build and returns a success result', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '',
        headers: { get: () => 'https://jenkins.example.com/queue/item/42/' },
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');
      const result = await provider.triggerBuild(makePayload(), makeContext());

      expect(result.success).toBe(true);
      expect(result.message).toContain('Jenkins build triggered');
      expect(result.buildId).toBe('42');
    });

    it('calls the correct Jenkins buildWithParameters URL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '',
        headers: { get: () => null },
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');
      await provider.triggerBuild(makePayload(), makeContext());

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('https://jenkins.example.com/');
      expect(calledUrl).toContain('job/my-folder/job/my-job/buildWithParameters');
      expect(calledUrl).toContain('SOURCE_WORKSPACE=my-workspace');
      expect(calledUrl).toContain('SOURCE_REPO=spoke-repo');
      expect(calledUrl).toContain('PR_ID=7');
      expect(calledUrl).toContain('SOURCE_BRANCH=feature%2Fcool-stuff');
    });

    it('sends the Basic auth header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '',
        headers: { get: () => null },
      });

      const provider = new JenkinsProvider(makeConfig(), 'secret-token');
      await provider.triggerBuild(makePayload(), makeContext());

      const options = mockFetch.mock.calls[0][1] as Record<string, unknown>;
      const headers = options.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Basic secret-token');
    });

    it('strips trailing slashes from jenkinsUrl', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '',
        headers: { get: () => null },
      });

      const config = makeConfig({ jenkinsUrl: 'https://jenkins.example.com///' });
      const provider = new JenkinsProvider(config, 'my-token');
      await provider.triggerBuild(makePayload(), makeContext());

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toMatch(/^https:\/\/jenkins\.example\.com\/job\//);
    });

    it('returns undefined buildId when Location header is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '',
        headers: { get: () => null },
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');
      const result = await provider.triggerBuild(makePayload(), makeContext());

      expect(result.buildId).toBeUndefined();
    });

    it('throws CIProviderError on a non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
        headers: { get: () => null },
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      await expect(
        provider.triggerBuild(makePayload(), makeContext()),
      ).rejects.toThrow(CIProviderError);
    });

    it('includes the HTTP status code in CIProviderError', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server Error',
        headers: { get: () => null },
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      try {
        await provider.triggerBuild(makePayload(), makeContext());
        fail('Expected CIProviderError');
      } catch (err) {
        expect(err).toBeInstanceOf(CIProviderError);
        expect((err as CIProviderError).statusCode).toBe(500);
        expect((err as CIProviderError).providerName).toBe('Jenkins');
      }
    });

    it('wraps unexpected errors in CIProviderError', async () => {
      mockFetch.mockRejectedValue(new Error('DNS resolution failed'));

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      await expect(
        provider.triggerBuild(makePayload(), makeContext()),
      ).rejects.toThrow(CIProviderError);

      try {
        await provider.triggerBuild(makePayload(), makeContext());
      } catch (err) {
        expect((err as CIProviderError).message).toContain('DNS resolution failed');
      }
    });
  });

  // -- getBuildStatus ------------------------------------------------------

  describe('getBuildStatus', () => {
    it('returns "QUEUED" when the queue item has no executable', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ blocked: false, stuck: false }),
        text: async () => '',
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');
      const status = await provider.getBuildStatus('42');

      expect(status).toBe('QUEUED');
    });

    it('returns the build result when executable is present', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          executable: { number: 10, result: 'SUCCESS', url: 'http://...' },
        }),
        text: async () => '',
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');
      const status = await provider.getBuildStatus('42');

      expect(status).toBe('SUCCESS');
    });

    it('returns "IN_PROGRESS" when executable exists but result is null', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          executable: { number: 10, result: null, url: 'http://...' },
        }),
        text: async () => '',
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');
      const status = await provider.getBuildStatus('42');

      expect(status).toBe('IN_PROGRESS');
    });

    it('calls the correct Jenkins queue item URL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
        text: async () => '',
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');
      await provider.getBuildStatus('99');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toBe('https://jenkins.example.com/queue/item/99/api/json');
    });

    it('throws CIProviderError on a non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      await expect(provider.getBuildStatus('bad-id')).rejects.toThrow(CIProviderError);
    });

    it('wraps unexpected errors in CIProviderError', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      await expect(provider.getBuildStatus('42')).rejects.toThrow(CIProviderError);
    });
  });
});
