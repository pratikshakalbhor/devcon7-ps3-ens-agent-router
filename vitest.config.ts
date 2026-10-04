import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The whole suite is hermetic: no RPC, no wallet, no API keys. Model calls are
    // served by an injected `fetch` stub, and chain reads are exercised separately
    // by `npm run verify` (which is read-only and needs only SEPOLIA_RPC_URL).
    testTimeout: 20_000,
  },
})
