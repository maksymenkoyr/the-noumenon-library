import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Store tests share one test database (schema apply + TRUNCATE), so
    // test files must not run concurrently.
    fileParallelism: false,
  },
});
