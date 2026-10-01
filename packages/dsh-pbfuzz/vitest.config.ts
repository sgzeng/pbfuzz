import { defineConfig } from 'vitest/config'

// Only the vitest specs. hooks/test/*.test.mjs are `node:test` files that import the pinned
// DSH checkout's bridge parser; they run under `pnpm test:hooks`, never under vitest.
export default defineConfig({
  test: {
    // Relative to `--dir tests` in the package script (the package root in a root `vitest` run):
    // only *.spec.ts ever matches, never hooks/test/*.test.mjs.
    include: ['**/*.spec.ts'],
    environment: 'node',
  },
})
