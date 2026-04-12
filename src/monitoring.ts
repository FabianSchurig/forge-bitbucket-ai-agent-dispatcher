/**
 * Monitoring module for the Forge Bitbucket AI Agent Dispatcher.
 *
 * Records dispatch events (success, failure, skipped) in Forge KVS
 * so workspace admins can review recent activity in the settings UI.
 *
 * Events are stored as a bounded FIFO array under a single storage key.
 * When the array exceeds MAX_EVENTS, the oldest entries are dropped.
 */

import kvs from '@forge/kvs';
import type { DispatchEvent } from './types';

/**
 * Storage key for the monitoring events array.
 * Uses a fixed key because events are not project-scoped — they are
 * a global log of all dispatcher activity in this workspace.
 */
const MONITORING_KEY = 'dispatch-events';

/**
 * Maximum number of events to retain.  Keeps storage usage bounded
 * while still providing a useful audit trail.
 */
const MAX_EVENTS = 50;

/**
 * Records a dispatch event in Forge Storage.
 *
 * The event is prepended to the existing array (most recent first).
 * When the array exceeds MAX_EVENTS, the oldest entries are silently
 * dropped.
 *
 * Errors are swallowed and logged — monitoring failures must never
 * block the main dispatch flow.
 */
export async function recordDispatchEvent(event: DispatchEvent): Promise<void> {
  try {
    const existing = (await kvs.get<DispatchEvent[]>(MONITORING_KEY)) ?? [];
    // Prepend the new event and trim to the maximum size.
    const updated = [event, ...existing].slice(0, MAX_EVENTS);
    await kvs.set(MONITORING_KEY, updated);
  } catch (err) {
    // Monitoring is best-effort — never let a storage error propagate.
    console.error('Monitoring: failed to record dispatch event:', err);
  }
}

/**
 * Retrieves recent dispatch events from Forge Storage.
 *
 * Returns events ordered newest-first.  Returns an empty array when
 * no events have been recorded or when storage is inaccessible.
 */
export async function getDispatchEvents(): Promise<DispatchEvent[]> {
  try {
    return (await kvs.get<DispatchEvent[]>(MONITORING_KEY)) ?? [];
  } catch (err) {
    console.error('Monitoring: failed to retrieve dispatch events:', err);
    return [];
  }
}
