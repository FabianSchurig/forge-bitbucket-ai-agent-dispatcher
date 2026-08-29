/**
 * Main entry point for the Forge app.
 *
 * Each named export corresponds to a `handler` value in manifest.yml:
 *   - runDispatcher    → trigger function for PR comment events
 *   - settingsResolver → resolver handler for settings read/write operations
 *   - jiraResolver     → resolver handler for the Jira issue-context panel
 *                        (getJiraContext / fetchRepositories / dispatchAgent)
 *
 * The settings UI is rendered natively by Forge via the `resources` entry in
 * manifest.yml pointing at `src/settings.tsx` — no separate handler export
 * is needed for the UI itself.
 */

export { runDispatcher } from './dispatcher';
export { handler as settingsResolver } from './resolvers';
export { handler as jiraResolver } from './jiraResolvers';
