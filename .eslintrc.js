module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.eslint.json',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    // Disallow `any` casts; use `unknown` and narrow with type guards.
    '@typescript-eslint/no-explicit-any': 'warn',
  },
};
