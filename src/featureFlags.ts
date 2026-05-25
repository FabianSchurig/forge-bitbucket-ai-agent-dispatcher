/**
 * Compile-time feature flags for the Forge Bitbucket AI Agent Dispatcher.
 *
 * These flags are intentionally plain `const` exports — they are *not* read
 * from runtime configuration. That makes them tree-shakeable and lets the
 * release workflow ship two physically different bundles from the same
 * source tree (see `.github/workflows/release-forge-app.yml`).
 *
 * The `lite` release variant rewrites this file with `sed` before bundling
 * so that the Jenkins integration is fully compiled out:
 *
 *   sed -i 's/JENKINS_ENABLED = true/JENKINS_ENABLED = false/' \
 *       src/featureFlags.ts
 *
 * Keeping the flag in a dedicated file (instead of, say, an env var or a
 * stored setting) means:
 *   * the `lite` UI never shows a Jenkins option the admin cannot use, and
 *   * the `lite` backend cannot accidentally instantiate a Jenkins provider
 *     even if a stale `ciType: 'JENKINS'` value lingers in Forge Storage.
 *
 * Any code added behind a feature flag MUST import its flag from this file
 * (never duplicate the constant) so that a single `sed` line is enough to
 * disable the feature everywhere.
 */

/**
 * When `false`, the Jenkins CI provider is hidden from the settings UI and
 * the ProviderFactory refuses to instantiate it. The wildcard egress entry
 * in `manifest.yml` (which exists solely for Jenkins) can then be removed
 * without breaking the app.
 */
export const JENKINS_ENABLED = true;
