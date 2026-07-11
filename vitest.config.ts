import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Store tests share one test database (schema apply + TRUNCATE), so
    // test files must not run concurrently.
    fileParallelism: false,
    // Don't collect tests from git worktrees checked out under .claude — they're
    // separate working copies that would run stale duplicates against the shared
    // test database.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
