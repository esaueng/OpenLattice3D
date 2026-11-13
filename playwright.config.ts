import { defineConfig, devices } from '@playwright/test'

// End-to-end checks against the production build served by `vite preview`,
// which sends the same CSP and COOP/COEP headers as production. The build here
// skips the `prebuild` unit-test hook: unit tests run in their own step.
const PORT = 4180
const baseURL = `http://127.0.0.1:${PORT}`

// WebGL in headless Chromium without a GPU: SwiftShader software rendering.
const chromiumArgs = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']

// Local sandboxes may ship a preinstalled Chromium instead of running
// `playwright install`; CI installs its own browser and leaves this unset.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // Generation and validation are CPU-bound Web Workers; keep a few pages at once.
  workers: process.env.CI ? 2 : 3,
  timeout: process.env.CI ? 120_000 : 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    acceptDownloads: true,
    launchOptions: { args: chromiumArgs, executablePath },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      // iPhone 13 metrics (390×664 CSS px, touch, DPR 3) on Chromium: CI installs Chromium only.
      name: 'iphone-13',
      use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' },
      grep: /@mobile/,
    },
  ],
  webServer: {
    command: `npx tsc -b && npx vite build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
