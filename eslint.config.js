const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: ['node_modules/**', 'build/**', 'src/__tests__/**', 'src/__mocks__/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.eslint.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Disable core ESLint rules that TypeScript handles (mirrors
      // `plugin:@typescript-eslint/eslint-recommended`).
      ...tsPlugin.configs['eslint-recommended'].overrides[0].rules,
      ...tsPlugin.configs.recommended.rules,
      // Disallow `any` casts; use `unknown` and narrow with type guards.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
