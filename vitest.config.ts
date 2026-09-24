import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
