import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // spike/ is Phase 0's throwaway code, kept as recorded; it is not linted.
    ignores: ['**/dist/**', '**/node_modules/**', 'spike/**'],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', fetch: 'readonly', structuredClone: 'readonly' },
    },
  },
  {
    files: ['packages/app/src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [{ group: ['@reins/*'], allowTypeImports: true }] }],
      'no-restricted-globals': ['error', 'process', 'Buffer'],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
