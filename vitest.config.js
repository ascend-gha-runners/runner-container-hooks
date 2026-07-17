import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'packages/k8s/src/**/*.spec.ts',
      'packages/docker/src/**/*.spec.ts',
      'packages/hooklib/src/**/*.spec.ts'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'clover', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'packages/k8s/src/**/*.ts',
        'packages/docker/src/**/*.ts',
        'packages/hooklib/src/**/*.ts'
      ],
      exclude: ['**/*.spec.ts', '**/*.d.ts']
    }
  }
})
