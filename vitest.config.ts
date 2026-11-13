import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
    // Playwright specs run under `npm run test:e2e`, never in Vitest.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    environment: 'node',
    // Geometry cases run marching cubes at production resolutions.
    testTimeout: 60000,
  },
})
