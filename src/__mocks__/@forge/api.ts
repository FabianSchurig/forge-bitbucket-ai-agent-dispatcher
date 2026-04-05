/**
 * Jest manual mock for @forge/api.
 *
 * Provides jest.fn() stubs for api.asApp().requestBitbucket(),
 * storage.get(), storage.set(), and the route template-literal tag.
 */

// __esModule: true tells Babel's interop layer that this is already an
// ES-module-shaped object, so `import api from '@forge/api'` resolves
// to `module.default` rather than the whole module.
export const __esModule = true;

const mockRequestBitbucket = jest.fn();

const api = {
  asApp: jest.fn().mockReturnValue({
    requestBitbucket: mockRequestBitbucket,
  }),
};

const storage = {
  get: jest.fn(),
  set: jest.fn(),
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
export { storage, route, mockRequestBitbucket };
