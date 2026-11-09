// Browser smoke tests. Run: npm run test:e2e
// Server 1: full site + Pages Functions on local workerd (fake credentials, throwaway D1/KV).
// Server 2: static site built with a booking URL, to test the calendar embed.
// Server 0: mock Google (token + Calendar API) reached by the Functions via GOOGLE_API_MOCK_ORIGIN.
import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'node:fs'

export const fixtures = Object.fromEntries(
  readFileSync(new URL('./test/e2e/fixtures.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"(.*)"$/, '$1')]),
)

const site = `http://127.0.0.1:${fixtures.E2E_PORT}`
const bookingSite = `http://127.0.0.1:${fixtures.E2E_BOOKING_PORT}`

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: site, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: [
    {
      command: 'node test/e2e/mock-google.mjs',
      env: { E2E_GOOGLE_MOCK_PORT: fixtures.E2E_GOOGLE_MOCK_PORT, E2E_GOOGLE_CLIENT_ID: fixtures.E2E_GOOGLE_CLIENT_ID },
      url: `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}/__health`,
      reuseExistingServer: false,
    },
    {
      command: 'bash test/e2e/serve.sh',
      url: site,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `vite build --outDir .wrangler/e2e-dist-booking --emptyOutDir --logLevel warn && vite preview --outDir .wrangler/e2e-dist-booking --host 127.0.0.1 --port ${fixtures.E2E_BOOKING_PORT} --strictPort`,
      env: { VITE_GHL_BOOKING_URL: fixtures.E2E_BOOKING_URL },
      url: bookingSite,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
  metadata: { bookingSite },
})
