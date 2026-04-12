/**
 * Jest manual mock for @forge/egress.
 *
 * Provides the EgressType enum used by settings.tsx when constructing
 * Customer-Managed Egress payloads.  The values match the real enum so tests
 * can assert on exact strings without coupling to the live Forge package.
 *
 * Note: __esModule markers are handled at test time via inline jest.mock()
 * factories.  They must NOT be exported as named exports here because the
 * Forge bundler processes src/ and rejects that syntax.
 */

export enum EgressType {
  FetchBackendSide = 'FETCH_BACKEND_SIDE',
  FetchClientSide = 'FETCH_CLIENT_SIDE',
  Fonts = 'FONTS',
  Frames = 'FRAMES',
  Images = 'IMAGES',
  Media = 'MEDIA',
  Navigation = 'NAVIGATION',
  Scripts = 'SCRIPTS',
  Styles = 'STYLES',
}
