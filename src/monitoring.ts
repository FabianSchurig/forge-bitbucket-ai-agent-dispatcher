/**
 * Monitoring module for the Forge Bitbucket AI Agent Dispatcher.
 *
 * Records dispatch events (success, failure, skipped) in Forge KVS
 * so project admins can review recent activity in the settings UI.
 *
 * Events are stored as individual timestamped keys under a project-scoped
 * prefix so concurrent writes never overwrite each other.  An index key
 * keeps a bounded list of the most recent event keys for efficient retrieval.
 */

import kvs from '@forge/kvs';
import type { DispatchEvent } from './types';

/**
 * Strips the curly-brace wrapper that Bitbucket adds around UUIDs
 * (e.g. "{abc-123}" → "abc-123") so the result is safe for KVS keys.
 */
function sanitizeUuid(uuid: string): string {
  return uuid.replace(/[{}]/g, '');
}

/**
 * Builds the index key for a project's monitoring event list.
 * The index holds an array of individual event key strings.
 */
function indexKey(projectUuid: string): string {
  return `dispatch-events-${sanitizeUuid(projectUuid)}`;
}

/**
 * Builds a unique key for an individual monitoring event.
 * Uses a timestamp + random suffix to avoid collisions from concurrent writes.
 */
function eventKey(projectUuid: string, timestamp: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `dispatch-evt-${sanitizeUuid(projectUuid)}-${timestamp.replace(/[:.]/g, '-')}-${suffix}`;
}

/**
 * Maximum number of events to retain per project.  Keeps storage usage
 * bounded while still providing a useful audit trail.
 */
const MAX_EVENTS = 50;

/**
 * Records a dispatch event in Forge Storage, scoped to a project.
 *
 * Each event is written to its own key (no read-modify-write on the
 * event data itself), which avoids lost updates when multiple dispatcher
 * invocations run concurrently.  A lightweight index key tracks the
 * most recent event keys per project.
 *
 * Note: the index update is still a read-modify-write, but losing an
 * index entry is much less impactful than losing the event data — the
 * event itself is safely persisted regardless.
 *
 * Errors are swallowed and logged — monitoring failures must never
 * block the main dispatch flow.
 */
export async function recordDispatchEvent(event: DispatchEvent): Promise<void> {
  try {
    const project = event.projectUuid || 'global';
    const key = eventKey(project, event.timestamp);

    // 1. Write the event itself — this is an atomic set, no race condition.
    await kvs.set(key, event);

    // 2. Update the index (bounded FIFO list of event keys).
    //    A concurrent update could lose this index entry, but the event
    //    data is already safely persisted above.
    const idx = indexKey(project);
    const existing = (await kvs.get<string[]>(idx)) ?? [];
    const updated = [key, ...existing].slice(0, MAX_EVENTS);

    // If the index shrank, delete the oldest event keys that were trimmed.
    const removed = existing.filter((k) => !updated.includes(k));
    await kvs.set(idx, updated);

    // Best-effort cleanup of old event keys.
    for (const oldKey of removed) {
      try {
        await kvs.delete(oldKey);
      } catch {
        // Ignore — old entries will simply be orphaned.
      }
    }
  } catch (err) {
    // Monitoring is best-effort — never let a storage error propagate.
    console.error('Monitoring: failed to record dispatch event:', err);
  }
}

/**
 * Retrieves recent dispatch events for a specific project from Forge Storage.
 *
 * Returns events ordered newest-first.  Returns an empty array when
 * no events have been recorded or when storage is inaccessible.
 *
 * @param projectUuid - The project to retrieve events for.
 *                      Returns empty array if not provided (no global events leak).
 */
export async function getDispatchEvents(projectUuid?: string): Promise<DispatchEvent[]> {
  if (!projectUuid) {
    return [];
  }

  try {
    const idx = indexKey(projectUuid);
    const keys = (await kvs.get<string[]>(idx)) ?? [];

    // Fetch all events in parallel for efficiency.
    const events = await Promise.all(
      keys.map(async (key) => {
        try {
          return await kvs.get<DispatchEvent>(key);
        } catch {
          return undefined;
        }
      }),
    );

    // Filter out any that were deleted or failed to load.
    return events.filter((e): e is DispatchEvent => e != null);
  } catch (err) {
    console.error('Monitoring: failed to retrieve dispatch events:', err);
    return [];
  }
}
