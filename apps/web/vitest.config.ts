import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/app/api/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        100: true,
      },
    },
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
