import { defineConfig } from '@playwright/test';

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseUrl ?? 'http://127.0.0.1:3000';
const e2eSupabaseUrl = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['line']],
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? '/tmp/voiceverse-playwright-artifacts',
  use: {
    baseURL,
    colorScheme: 'dark',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        // Webpack is intentionally used for browser tests. Turbopack's worker pool
        // can consume excessive temporary disk space on constrained CI runners.
        command: 'pnpm exec next dev --webpack --hostname 127.0.0.1 --port 3000',
        env: {
          ...process.env,
          NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3001/v1',
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'voiceverse_e2e_publishable_key',
          NEXT_PUBLIC_SUPABASE_URL: e2eSupabaseUrl,
        },
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
