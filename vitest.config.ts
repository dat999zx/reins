import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Tests run core from source; the built `reins` bin uses core's dist (package.json main).
    alias: { '@reins/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)) },
  },
  test: {
    passWithNoTests: true,
    environment: 'node',
    fileParallelism: false,
    // Server tests spawn real child processes (fake claude, MCP server); on a busy Windows box that
    // outruns vitest's 5 s default and flakes. Nothing here should need more than this.
    testTimeout: 30_000,
    // One project per package, so a setup file runs for ONE package only (a global `setupFiles` would run in every test file).
    // The app's setup fills its kinds from the same builder the server's `GET /api/kinds` uses; core and server have none yet.
    projects: [
      { extends: true, test: { name: 'core', include: ['packages/core/test/**/*.test.ts'] } },
      { extends: true, test: { name: 'server', include: ['packages/server/test/**/*.test.ts', 'test/**/*.test.ts'] } },
      { extends: true, test: { name: 'app', include: ['packages/app/test/**/*.test.ts'], setupFiles: ['packages/app/test/setup-kinds.ts'] } },
    ],
  },
});
