import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
    environment: 'node',
    // Geometry cases run marching cubes at production resolutions.
    testTimeout: 60000,
  },
})
