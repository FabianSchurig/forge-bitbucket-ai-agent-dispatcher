/**
 * Custom error class for CI/CD provider failures.
 *
 * All provider implementations should throw CIProviderError instead of
 * generic Error instances.  This allows the dispatcher and UI to display
 * a consistent error message regardless of which backend tool failed.
 *
 * The providerName field lets callers include the failing tool in their
 * error messages (e.g. "Jenkins failed: …" vs "Bitbucket Pipelines failed: …").
 */
export class CIProviderError extends Error {
  /** Human-readable name of the failing provider (e.g. "Jenkins"). */
  public readonly providerName: string;

  /** Optional HTTP status code returned by the CI tool's API. */
  public readonly statusCode?: number;

  constructor(providerName: string, message: string, statusCode?: number) {
    super(`${providerName}: ${message}`);
    this.name = 'CIProviderError';
    this.providerName = providerName;
    this.statusCode = statusCode;

    // Fix prototype chain for instanceof checks in transpiled code.
    Object.setPrototypeOf(this, CIProviderError.prototype);
  }
}
