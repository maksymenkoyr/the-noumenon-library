// Nightly off-provider backup (docs/architecture.md §9, docs/operations.md):
// pg_dump the store to a compressed custom-format dump and upload it to
// Cloudflare R2 (S3-compatible). Beyond Neon's own PITR, this is the
// belt-and-suspenders copy so a Neon-account-level failure isn't fatal.
//
// Usage: npm run backup   (loads .env.local if present; CI passes env directly)
import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { AwsClient } from "aws4fetch";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

// pg_dump wants a *direct* (unpooled) connection — PgBouncer chokes on it.
const databaseUrl =
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  process.exit(1);
}

const accountId = required("R2_ACCOUNT_ID");
const accessKeyId = required("R2_ACCESS_KEY_ID");
const secretAccessKey = required("R2_SECRET_ACCESS_KEY");
const bucket = required("R2_BUCKET");
const prefix = process.env.BACKUP_PREFIX ?? "backups/";
const dir = process.env.BACKUP_DIR ?? tmpdir();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = `noumenon-${stamp}.dump`;
const dumpPath = join(dir, filename);
const key = `${prefix}${filename}`;

/** Run a child process, inheriting stdio, rejecting on non-zero exit. */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
    );
  });
}

// 1. Source integrity snapshot: how many pages the restore must reproduce.
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
let pageCount;
try {
  const { rows } = await client.query("SELECT count(*)::int AS n FROM pages");
  pageCount = rows[0].n;
} finally {
  await client.end();
}

// 2. Dump — custom format (-Fc): compressed and restorable with pg_restore.
await run("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", dumpPath, databaseUrl]);

// 3. Upload to R2. The pages table only grows and is immutable after commit, so
// a full nightly dump stays cheap; a single PUT is fine at this scale.
const body = await readFile(dumpPath);
const aws = new AwsClient({
  accessKeyId,
  secretAccessKey,
  service: "s3",
  region: "auto", // R2 uses the "auto" region
});
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
const res = await aws.fetch(`${endpoint}/${bucket}/${key}`, {
  method: "PUT",
  body,
  headers: { "content-type": "application/octet-stream" },
});
if (!res.ok) {
  console.error(`R2 upload failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

console.log(
  `Backup uploaded: r2://${bucket}/${key} (${body.length} bytes, ${pageCount} pages)`,
);

// 4. Hand the local dump + expected count to the workflow's test-restore step.
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `dumpfile=${dumpPath}\npages=${pageCount}\n`,
  );
}
