/**
 * Jest manual mock for @forge/kvs.
 *
 * Provides jest.fn() stubs for kvs.get(), kvs.set(), kvs.delete(),
 * kvs.getSecret(), and kvs.setSecret() so tests can run without
 * Forge infrastructure.
 */
const kvs = {
  get: jest.fn(),
  set: jest.fn(),
  delete: jest.fn(),
  getSecret: jest.fn(),
  setSecret: jest.fn(),
  deleteSecret: jest.fn(),
};

export { kvs };
export default kvs;
