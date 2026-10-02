import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Real-DSH tests: no mocks of `@deepseek-ai/*`. global-setup.ts installs the newest DeepSeek
// Harness from npm, builds and packs both plugins, and installs them into a scratch profile with
// the real `dsh plugin add`; each spec then boots that profile in-process (see harness.ts).
// Deliberately not part of `pnpm -r test` / the root vitest projects: it needs the network and a
// 500 MB install. Run it with `pnpm run test:dsh`.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ['*.spec.ts'],
    globalSetup: ['./global-setup.ts'],
    // `runProfile` installs process-level signal and fail-loud handlers, so every spec file gets
    // its own process, and files run one after another over their own copy of the DSH home.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
