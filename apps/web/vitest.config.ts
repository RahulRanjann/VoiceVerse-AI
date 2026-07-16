import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: [
        'src/app/api/**/*.ts',
        'src/features/uploads/checkpoint-store.ts',
        'src/features/uploads/multipart-upload.ts',
        'src/lib/api.ts',
      ],
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        branches: 75,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
