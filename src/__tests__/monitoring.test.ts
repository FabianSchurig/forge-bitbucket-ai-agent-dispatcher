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
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kvsMock = jest.requireMock('@forge/kvs') as any;
const mockGet: jest.Mock = kvsMock.default.get;
const mockSet: jest.Mock = kvsMock.default.set;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<DispatchEvent> = {}): DispatchEvent {
  return {
    timestamp: '2026-04-12T14:00:00.000Z',
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
    mockGet.mockResolvedValue(undefined);
    mockSet.mockResolvedValue(undefined);
  });

  // -- recordDispatchEvent ------------------------------------------------

  describe('recordDispatchEvent', () => {
    it('stores a new event when no existing events exist', async () => {
      mockGet.mockResolvedValue(undefined);

      const event = makeEvent();
      await recordDispatchEvent(event);

      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith('dispatch-events', [event]);
    });

    it('prepends a new event to existing events', async () => {
      const existing = [makeEvent({ prId: 1 })];
      mockGet.mockResolvedValue(existing);

      const newEvent = makeEvent({ prId: 2 });
      await recordDispatchEvent(newEvent);

      const savedEvents = mockSet.mock.calls[0][1] as DispatchEvent[];
      expect(savedEvents[0].prId).toBe(2);
      expect(savedEvents[1].prId).toBe(1);
    });

    it('trims events to the maximum of 50', async () => {
      // Create 50 existing events.
      const existing = Array.from({ length: 50 }, (_, i) =>
        makeEvent({ prId: i }),
      );
      mockGet.mockResolvedValue(existing);

      const newEvent = makeEvent({ prId: 999 });
      await recordDispatchEvent(newEvent);

      const savedEvents = mockSet.mock.calls[0][1] as DispatchEvent[];
      expect(savedEvents).toHaveLength(50);
      // The newest event should be first.
      expect(savedEvents[0].prId).toBe(999);
      // The oldest event (index 49) should have been dropped.
      expect(savedEvents[49].prId).toBe(48);
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

      const savedEvents = mockSet.mock.calls[0][1] as DispatchEvent[];
      expect(savedEvents[0].buildUrl).toBe('https://example.com/pipeline/1');
    });
  });

  // -- getDispatchEvents --------------------------------------------------

  describe('getDispatchEvents', () => {
    it('returns stored events', async () => {
      const events = [makeEvent({ prId: 1 }), makeEvent({ prId: 2 })];
      mockGet.mockResolvedValue(events);

      const result = await getDispatchEvents();

      expect(result).toEqual(events);
    });

    it('returns an empty array when no events exist', async () => {
      mockGet.mockResolvedValue(undefined);

      const result = await getDispatchEvents();

      expect(result).toEqual([]);
    });

    it('returns an empty array on storage errors', async () => {
      mockGet.mockRejectedValue(new Error('Storage unavailable'));

      const result = await getDispatchEvents();

      expect(result).toEqual([]);
    });
  });
});
