/**
 * Jest manual mock for @forge/bridge.
 *
 * Stubs out invoke() and getContext() so settings component tests
 * can control what the "backend" returns.
 */

export const invoke = jest.fn();
export const getContext = jest.fn();
