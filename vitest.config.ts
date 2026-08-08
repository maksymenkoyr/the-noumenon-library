import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The app's own `@/…` imports (tsconfig `paths`) — lib tests use relative
  // paths, but a component test pulls in a module that doesn't.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    // Store tests share one test database (schema apply + TRUNCATE), so
    // test files must not run concurrently.
    fileParallelism: false,
    // Don't collect tests from git worktrees checked out under .claude — they're
    // separate working copies that would run stale duplicates against the shared
    // test database.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    // The catch-all route directory is literally named `[[...address]]`, which a
    // glob reads as a character class — so a colocated test there is silently
    // never collected. Opt it in explicitly rather than leaving a test file that
    // looks like it runs and doesn't.
    include: [...configDefaults.include, "app/\\[\\[...address\\]\\]/*.test.tsx"],
  },
});
