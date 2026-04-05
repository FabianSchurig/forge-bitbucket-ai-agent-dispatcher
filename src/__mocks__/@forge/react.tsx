/**
 * Jest manual mock for @forge/react.
 *
 * Re-exports React's real hooks so component logic can be tested,
 * while stubbing out Forge-specific UI components and ForgeReconciler.
 */

import React from 'react';

const ForgeReconciler = {
  render: jest.fn(),
};

export default ForgeReconciler;

// Stub UI Kit 2 components as simple pass-through React elements.
const makeStub = (name: string) => {
  const stub = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(name, null, children);
  stub.displayName = name;
  return stub;
};

export const Button = makeStub('Button');
export const Form = makeStub('Form');
export const FormSection = makeStub('FormSection');
export const Heading = makeStub('Heading');
export const Label = makeStub('Label');
export const SectionMessage = makeStub('SectionMessage');
export const Stack = makeStub('Stack');
export const Text = makeStub('Text');
export const TextField = makeStub('TextField');
