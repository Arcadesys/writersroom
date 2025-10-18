import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    includeSource: ['src/**/*.{js,ts}'],
    exclude: ['node_modules', 'dist', '.obsidian']
  },
  esbuild: {
    target: 'es2020'
  }
});