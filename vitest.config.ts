import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      obsidian: resolve(rootDir, "tests/mocks/obsidian.ts")
    }
  },
  test: {
    environment: "node",
    globals: false,
    includeSource: ["src/**/*.{js,ts}"],
    exclude: ["node_modules", "dist", ".obsidian"]
  },
  esbuild: {
    target: "es2020"
  }
});
