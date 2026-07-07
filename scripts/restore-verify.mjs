// Test-restore a backup into a throwaway database and verify it — an
// unrestorable backup is not a backup (docs/architecture.md §9). The nightly
// workflow runs this against a fresh postgres service container right after the
// dump; it can also be run locally against a scratch DB.
//
// Usage: npm run restore:verify -- <dumpfile> [expectedPageCount]
// Requires TARGET_DATABASE_URL — the scratch DB. NEVER the production store:
// the restore runs with --clean and would drop/recreate its objects.
import { spawn } from "node:child_process";
import pg from "pg";

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error(
    "Usage: npm run restore:verify -- <dumpfile> [expectedPageCount]",
  );
  process.exit(1);
}
const expected = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;

const target = process.env.TARGET_DATABASE_URL;
if (!target) {
  console.error(
    "TARGET_DATABASE_URL must be set (a scratch DB, never production)",
  );
  process.exit(1);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
    );
  });
}

// 1. Restore into the scratch DB (--clean/--if-exists → re-runs are idempotent).
await run("pg_restore", [
  "--clean",
  "--if-exists",
  "--no-owner",
  "--no-acl",
  "-d",
  target,
  dumpPath,
]);

// 2. Verify: pages restored, count matches the source, and every committed page
// still carries its content_hash (a structurally intact, not just present, dump).
const client = new pg.Client({ connectionString: target });
await client.connect();
try {
  const {
    rows: [{ n: pages }],
  } = await client.query("SELECT count(*)::int AS n FROM pages");
  const {
    rows: [{ n: broken }],
  } = await client.query(
    "SELECT count(*)::int AS n FROM pages WHERE status = 'ok' AND content_hash IS NULL",
  );

  if (expected !== undefined) {
    if (pages !== expected) {
      throw new Error(`restored ${pages} pages, expected ${expected}`);
    }
  } else if (pages === 0) {
    throw new Error("restored pages table is empty");
  }
  if (broken > 0) {
    throw new Error(`${broken} committed pages have no content_hash`);
  }

  console.log(
    `Restore verified: ${pages} pages${
      expected !== undefined ? " (matches source)" : ""
    }, integrity ok`,
  );
} finally {
  await client.end();
}
