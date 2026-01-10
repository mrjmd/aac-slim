import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['node_modules', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'app/api/**/*.ts',
        'src/**/*.ts',
        'lib/**/*.ts',
      ],
    },
  },
  resolve: {
    alias: {
      // Match tsconfig.json paths exactly
      '@/lib': resolve(__dirname, './src/lib'),
      '@/clients': resolve(__dirname, './src/clients'),
      '@': resolve(__dirname, './'),
    },
  },
})
