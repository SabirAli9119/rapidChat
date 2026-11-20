import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Starts one temporary MongoDB for the whole run
    globalSetup: ['./tests/globalSetup.ts'],
    // Runs before every test file, before any project file is loaded
    setupFiles: ['./tests/setup.ts'],
    // Separate processes: the password-hashing library is a native module
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});