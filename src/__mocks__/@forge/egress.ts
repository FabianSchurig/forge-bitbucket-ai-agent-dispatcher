/**
 * Jest manual mock for @forge/egress.
 *
 * Provides the EgressType enum used by settings.tsx when constructing
 * Customer-Managed Egress payloads.  Only the values relevant to the app
 * are included; Forge's backend fetch (FetchBackendSide) is the only one
 * used in production code.
 *
 * Note: __esModule markers are handled at test time via inline jest.mock()
 * factories.  They must NOT be exported as named exports here because the
 * Forge bundler processes src/ and rejects that syntax.
 */

export enum EgressType {
  FetchBackendSide = 'FETCH_BACKEND_SIDE',
  FetchClientSide = 'FETCH_CLIENT_SIDE',
}
