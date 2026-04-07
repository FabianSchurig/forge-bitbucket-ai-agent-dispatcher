/**
 * Main entry point for the Forge app.
 *
 * Each named export corresponds to a `handler` value in manifest.yml:
 *   - runDispatcher    → trigger function for PR comment events
 *   - renderSettings   → UI Kit 2 renderer for the workspace settings page
 *   - settingsResolver → resolver handler for settings read/write operations
 */

export { runDispatcher } from './dispatcher';
export { handler as settingsResolver } from './resolvers';
