import { recordDispatchEvent, getDispatchEvents } from '../monitoring';
import type { DispatchEvent } from '../types';

// ---------------------------------------------------------------------------
// Mock @forge/kvs (used by monitoring.ts)
// ---------------------------------------------------------------------------

jest.mock('@forge/kvs', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kvsMock = jest.requireMock('@forge/kvs') as any;
const mockGet: jest.Mock = kvsMock.default.get;
const mockSet: jest.Mock = kvsMock.default.set;
const mockDelete: jest.Mock = kvsMock.default.delete;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<DispatchEvent> = {}): DispatchEvent {
  return {
    timestamp: '2026-04-12T14:00:00.000Z',
    projectUuid: '{proj-uuid}',
    workspaceUuid: '{ws-uuid}',
    repoUuid: '{repo-uuid}',
    prId: 7,
    commentId: 42,
    status: 'SUCCESS',
    provider: 'BITBUCKET_PIPELINES',
    message: 'Pipeline triggered.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('monitoring', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockReset();
    mockDelete.mockReset();
    mockGet.mockResolvedValue(undefined);
    mockSet.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
  });

  // -- recordDispatchEvent ------------------------------------------------

  describe('recordDispatchEvent', () => {
    it('stores a new event when no existing index exists', async () => {
      mockGet.mockResolvedValue(undefined);

      const event = makeEvent();
      await recordDispatchEvent(event);

      // Should write the event to its own key.
      expect(mockSet).toHaveBeenCalledTimes(2); // event + index
      const eventSetCall = mockSet.mock.calls[0];
      expect(eventSetCall[1]).toEqual(event);

      // Should write the index with the event key.
      const indexSetCall = mockSet.mock.calls[1];
      expect(indexSetCall[1]).toHaveLength(1);
      expect(indexSetCall[1][0]).toBe(eventSetCall[0]);
    });

    it('prepends a new event key to the existing index', async () => {
      const existingKey = 'dispatch-evt-proj-uuid-old';
      // First call: kvs.get for index returns existing keys.
      mockGet.mockResolvedValueOnce([existingKey]);

      const event = makeEvent({ prId: 2 });
      await recordDispatchEvent(event);

      // Index should have 2 keys, new one first.
      const indexSetCall = mockSet.mock.calls[1];
      expect(indexSetCall[1]).toHaveLength(2);
      expect(indexSetCall[1][0]).not.toBe(existingKey); // new key is first
      expect(indexSetCall[1][1]).toBe(existingKey);
    });

    it('trims index to the maximum of 50 and deletes old event keys', async () => {
      // Create 50 existing event keys.
      const existingKeys = Array.from({ length: 50 }, (_, i) =>
        `dispatch-evt-proj-uuid-old-${i}`,
      );
      mockGet.mockResolvedValueOnce(existingKeys);

      const event = makeEvent({ prId: 999 });
      await recordDispatchEvent(event);

      // Index should still be 50 entries (new + 49 old).
      const indexSetCall = mockSet.mock.calls[1];
      expect(indexSetCall[1]).toHaveLength(50);

      // The oldest key should have been deleted.
      expect(mockDelete).toHaveBeenCalledWith('dispatch-evt-proj-uuid-old-49');
    });

    it('swallows storage errors without throwing', async () => {
      mockGet.mockRejectedValue(new Error('Storage unavailable'));

      const event = makeEvent();
      // Should not throw.
      await expect(recordDispatchEvent(event)).resolves.toBeUndefined();
    });

    it('stores event with buildUrl when provided', async () => {
      const event = makeEvent({ buildUrl: 'https://example.com/pipeline/1' });
      await recordDispatchEvent(event);

      const eventSetCall = mockSet.mock.calls[0];
      expect(eventSetCall[1].buildUrl).toBe('https://example.com/pipeline/1');
    });

    it('scopes storage keys by project UUID', async () => {
      const event = makeEvent({ projectUuid: '{my-project-123}' });
      await recordDispatchEvent(event);

      // Event key should contain the sanitised project UUID.
      const eventKey = mockSet.mock.calls[0][0] as string;
      expect(eventKey).toContain('my-project-123');
      expect(eventKey).not.toContain('{');

      // Index key should also be project-scoped.
      const idxKey = mockSet.mock.calls[1][0] as string;
      expect(idxKey).toBe('dispatch-events-my-project-123');
    });
  });

  // -- getDispatchEvents --------------------------------------------------

  describe('getDispatchEvents', () => {
    it('returns events for a specific project', async () => {
      const eventKeys = ['dispatch-evt-proj-1', 'dispatch-evt-proj-2'];
      const events = [makeEvent({ prId: 1 }), makeEvent({ prId: 2 })];

      // First call: get index.
      mockGet.mockResolvedValueOnce(eventKeys);
      // Subsequent calls: get individual events.
      mockGet.mockResolvedValueOnce(events[0]);
      mockGet.mockResolvedValueOnce(events[1]);

      const result = await getDispatchEvents('{proj-uuid}');

      expect(result).toEqual(events);
      // Should have read the index key for this project.
      expect(mockGet).toHaveBeenCalledWith('dispatch-events-proj-uuid');
    });

    it('returns an empty array when no projectUuid is provided', async () => {
      const result = await getDispatchEvents();

      expect(result).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('returns an empty array when no index exists', async () => {
      mockGet.mockResolvedValue(undefined);

      const result = await getDispatchEvents('{proj-uuid}');

      expect(result).toEqual([]);
    });

    it('returns an empty array on storage errors', async () => {
      mockGet.mockRejectedValue(new Error('Storage unavailable'));

      const result = await getDispatchEvents('{proj-uuid}');

      expect(result).toEqual([]);
    });

    it('skips events that fail to load individually', async () => {
      const eventKeys = ['key-ok', 'key-fail'];
      const goodEvent = makeEvent({ prId: 1 });

      mockGet.mockResolvedValueOnce(eventKeys);
      mockGet.mockResolvedValueOnce(goodEvent);
      mockGet.mockRejectedValueOnce(new Error('gone'));

      const result = await getDispatchEvents('{proj-uuid}');

      expect(result).toHaveLength(1);
      expect(result[0].prId).toBe(1);
    });
  });
});
