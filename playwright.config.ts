import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 300_000, // 5 min — model download can be slow
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    // Chromium with WebGPU enabled
    channel: 'chromium',
    launchOptions: {
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5173',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
