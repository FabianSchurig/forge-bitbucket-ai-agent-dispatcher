import { CIProviderError } from '../interfaces/CIProviderError';

// ---------------------------------------------------------------------------
// CIProviderError
// ---------------------------------------------------------------------------

describe('CIProviderError', () => {
  it('includes the provider name in the error message', () => {
    const err = new CIProviderError('Jenkins', 'connection refused');
    expect(err.message).toBe('Jenkins: connection refused');
  });

  it('sets the name property to "CIProviderError"', () => {
    const err = new CIProviderError('Jenkins', 'timeout');
    expect(err.name).toBe('CIProviderError');
  });

  it('stores the providerName property', () => {
    const err = new CIProviderError('Bitbucket Pipelines', 'out of minutes');
    expect(err.providerName).toBe('Bitbucket Pipelines');
  });

  it('stores the statusCode when provided', () => {
    const err = new CIProviderError('Jenkins', 'forbidden', 403);
    expect(err.statusCode).toBe(403);
  });

  it('leaves statusCode undefined when not provided', () => {
    const err = new CIProviderError('Jenkins', 'network error');
    expect(err.statusCode).toBeUndefined();
  });

  it('is an instance of Error', () => {
    const err = new CIProviderError('Jenkins', 'fail');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of CIProviderError', () => {
    const err = new CIProviderError('Jenkins', 'fail');
    expect(err).toBeInstanceOf(CIProviderError);
  });
});
