/**
 * Jest manual mock for @forge/bridge.
 *
 * Stubs out invoke(), view.getContext(), and permissions.egress.set() so
 * settings component tests can control what the "backend" returns and simulate
 * the Forge extension context (e.g. project UUID) and egress permission flows.
 */

export const invoke = jest.fn();

export const view = {
  getContext: jest.fn(),
};

/**
 * Mock for the Customer-Managed Egress API.
 * permissions.egress.set() triggers the Atlassian admin consent modal for
 * approving outbound domains at runtime.
 */
export const permissions = {
  egress: {
    set: jest.fn(),
  },
};
