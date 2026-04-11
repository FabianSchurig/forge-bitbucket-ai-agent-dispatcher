/**
 * Jest manual mock for @forge/bridge.
 *
 * Stubs out invoke() and view.getContext() so settings component tests
 * can control what the "backend" returns and simulate the Forge
 * extension context (e.g. project UUID).
 */

export const invoke = jest.fn();

export const view = {
  getContext: jest.fn(),
};
