import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'src/client/**/*.test.ts'],
    environment: 'node',
  },
})
