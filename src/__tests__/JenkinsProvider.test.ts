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

describe('JenkinsProvider', () => {
  beforeEach(() => mockFetch.mockReset());

  // -- triggerBuild --------------------------------------------------------

  describe('triggerBuild', () => {
    it('triggers a Jenkins build and returns a success result with build URL', async () => {
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
      expect(result.buildUrl).toBe(
        'https://jenkins.example.com/job/my-folder/job/my-job',
      );
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
      // COMMENT_TEXT is intentionally excluded from URL params (security).
      // Only COMMENT_ID is sent so CI jobs can fetch content server-side.
      expect(calledUrl).not.toContain('COMMENT_TEXT');
      expect(calledUrl).toContain('COMMENT_ID=42');
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

    it('fetches the build endpoint and returns the result when executable has a URL', async () => {
      // First call: queue item with executable URL
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            executable: { number: 10, url: 'https://jenkins.example.com/job/my-job/10/' },
          }),
          text: async () => '',
        })
        // Second call: build status endpoint
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            building: false,
            result: 'SUCCESS',
          }),
          text: async () => '',
        });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');
      const status = await provider.getBuildStatus('42');

      expect(status).toBe('SUCCESS');
      // Verify the second fetch was to the executable build API
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const secondUrl = mockFetch.mock.calls[1][0] as string;
      expect(secondUrl).toBe('https://jenkins.example.com/job/my-job/10/api/json');
    });

    it('returns "IN_PROGRESS" when the build is still running', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            executable: { number: 10, url: 'https://jenkins.example.com/job/my-job/10/' },
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            building: true,
            result: null,
          }),
          text: async () => '',
        });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');
      const status = await provider.getBuildStatus('42');

      expect(status).toBe('IN_PROGRESS');
    });

    it('returns "IN_PROGRESS" when executable exists but has no URL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          executable: { number: 10 },
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

    it('throws CIProviderError on a non-OK queue item response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      await expect(provider.getBuildStatus('bad-id')).rejects.toThrow(CIProviderError);
    });

    it('throws CIProviderError on a non-OK build status response', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            executable: { number: 10, url: 'https://jenkins.example.com/job/my-job/10/' },
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Server Error',
        });

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      await expect(provider.getBuildStatus('42')).rejects.toThrow(CIProviderError);
    });

    it('wraps unexpected errors in CIProviderError', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      await expect(provider.getBuildStatus('42')).rejects.toThrow(CIProviderError);
    });

    it('throws CIProviderError with egress guidance when REQUEST_EGRESS_ALLOWLIST_ERR occurs in getBuildStatus', async () => {
      // Forge's network proxy throws REQUEST_EGRESS_ALLOWLIST_ERR when the
      // domain has not been approved via Customer-Managed Egress or was revoked.
      mockFetch.mockRejectedValue(new Error('REQUEST_EGRESS_ALLOWLIST_ERR: domain not in allowlist'));

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      try {
        await provider.getBuildStatus('42');
        fail('Expected CIProviderError');
      } catch (err) {
        expect(err).toBeInstanceOf(CIProviderError);
        // The message should guide the admin to re-authorize the URL.
        expect((err as CIProviderError).message).toMatch(/egress|re-authorize|allowlist/i);
        expect((err as CIProviderError).providerName).toBe('Jenkins');
      }
    });
  });

  // -- Egress allowlist error handling -------------------------------------

  describe('egress allowlist error handling', () => {
    it('throws CIProviderError with egress guidance when REQUEST_EGRESS_ALLOWLIST_ERR occurs in triggerBuild', async () => {
      // Forge's proxy returns REQUEST_EGRESS_ALLOWLIST_ERR when the Jenkins
      // domain was never approved by an admin or has since been revoked.
      mockFetch.mockRejectedValue(
        new Error('REQUEST_EGRESS_ALLOWLIST_ERR: https://jenkins.example.com is not in the allowlist'),
      );

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      try {
        await provider.triggerBuild(makePayload(), makeContext());
        fail('Expected CIProviderError');
      } catch (err) {
        expect(err).toBeInstanceOf(CIProviderError);
        // Error message should clearly indicate this is an egress allowlist
        // issue and direct the admin to re-authorize the domain in settings.
        expect((err as CIProviderError).message).toMatch(/egress|re-authorize|allowlist/i);
        expect((err as CIProviderError).providerName).toBe('Jenkins');
      }
    });

    it('does not lose other error details when wrapping non-egress errors', async () => {
      // Verify that non-egress network errors are still wrapped normally
      // and do not accidentally match the egress error pattern.
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED: connection refused'));

      const provider = new JenkinsProvider(makeConfig(), 'my-token');

      try {
        await provider.triggerBuild(makePayload(), makeContext());
        fail('Expected CIProviderError');
      } catch (err) {
        expect(err).toBeInstanceOf(CIProviderError);
        expect((err as CIProviderError).message).toContain('ECONNREFUSED');
      }
    });
  });
});
