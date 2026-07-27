import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Geometry cases run marching cubes at production resolutions, which takes
    // seconds rather than milliseconds.
    testTimeout: 60000,
  },
});
