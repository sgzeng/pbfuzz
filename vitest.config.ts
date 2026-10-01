import { defineConfig } from 'vitest/config'

// Running `vitest` from the repo root delegates to each package's own config, so a root run
// collects exactly what `pnpm -r test` does. In particular it never picks up
// packages/dsh-pbfuzz/hooks/test/*.test.mjs, which are `node:test` files (run them with
// `pnpm test:hooks`), nor anything under engine/.
export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
})
