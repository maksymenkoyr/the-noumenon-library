// Private-access invite links (private-share deploy). Issues reusable links,
// each unique and DB-registered (token is the PRIMARY KEY, so duplicates are
// impossible). Redeeming a link (app/api/access) drops a session cookie in that
// browser; the link keeps working on any device, any number of times.
//
// Usage:
//   npm run invite -- "alice"     create a link (label optional)
//   npm run invite -- --list      list every issued link + its status
//
// The printed base URL defaults to the production domain; override with
// PUBLIC_BASE_URL=https://… npm run invite -- "bob"
import { randomBytes } from "node:crypto";
import pg from "pg";

const arg = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const base = (
  process.env.PUBLIC_BASE_URL ?? "https://the-noumenon-library.vercel.app"
).replace(/\/$/, "");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  if (arg === "--list" || arg === "ls") {
    const { rows } = await client.query(
      `SELECT token, label, created_at, redeemed_at, redeemed_ip
         FROM access_tokens ORDER BY created_at DESC`,
    );
    if (rows.length === 0) {
      console.log("No invites issued yet.");
    }
    for (const r of rows) {
      const status = r.redeemed_at
        ? `last used ${new Date(r.redeemed_at).toISOString()}${r.redeemed_ip ? ` from ${r.redeemed_ip}` : ""}`
        : "unused";
      console.log(
        `${(r.label ?? "(no label)").padEnd(16)} ${status.padEnd(48)} ${base}/api/access?invite=${r.token}`,
      );
    }
  } else {
    const label = arg ?? null;
    // 128-bit token; the PK guarantees uniqueness — retry on the astronomically
    // unlikely collision rather than trusting entropy blindly. The link is
    // reusable, so one row can serve a person across all their devices.
    let token = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = randomBytes(16).toString("hex");
      const { rows } = await client.query(
        `INSERT INTO access_tokens (token, label) VALUES ($1, $2)
           ON CONFLICT (token) DO NOTHING RETURNING token`,
        [candidate, label],
      );
      if (rows.length > 0) {
        token = rows[0].token;
        break;
      }
    }
    if (!token) {
      console.error("Failed to generate a unique token after 5 attempts");
      process.exit(1);
    }
    console.log(`Invite link${label ? ` for ${label}` : ""} (reusable):`);
    console.log(`${base}/api/access?invite=${token}`);
  }
} finally {
  await client.end();
}
