/**
 * Jest manual mock for @forge/api.
 *
 * Provides jest.fn() stubs for api.asApp().requestBitbucket(),
 * api.fetch(), storage.get(), storage.set(), storage.getSecret(),
 * storage.setSecret(), and the route template-literal tag.
 *
 * Note: __esModule markers are handled by Jest at test time via the module
 * factory's __esModule property. They must NOT be exported as named exports
 * because the Forge bundler processes src/ and rejects the syntax.
 */

const mockRequestBitbucket = jest.fn();
const mockFetch = jest.fn();

const api = {
  asApp: jest.fn().mockReturnValue({
    requestBitbucket: mockRequestBitbucket,
  }),
  fetch: mockFetch,
};

const storage = {
  get: jest.fn(),
  set: jest.fn(),
  getSecret: jest.fn(),
  setSecret: jest.fn(),
};

/**
 * Mock for the `route` template-literal tag.
 * Concatenates the template strings and interpolated values into a plain string
 * so tests can easily assert on the resulting URL.
 */
function route(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce(
    (acc, str, i) => acc + str + (i < values.length ? String(values[i]) : ''),
    '',
  );
}

export default api;
export { storage, route, mockRequestBitbucket, mockFetch };
