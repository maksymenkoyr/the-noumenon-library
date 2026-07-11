// Private-access invite links (private-share deploy). Issues reusable links,
// each unique and DB-registered (token is the PRIMARY KEY, so duplicates are
// impossible). Redeeming a link (app/api/access) drops a session cookie in that
// browser; the link keeps working on any device, any number of times.
//
// Usage:
//   npm run invite -- "alice"                  create a link (label optional)
//   npm run invite -- --dev "alice"            create a dev-mode link (sees the overlay)
//   npm run invite -- --operator "alice"       create an operator link (can reach /operator)
//   npm run invite -- --grant-dev <tok>        upgrade an existing link to dev mode
//   npm run invite -- --grant-operator <tok>   upgrade an existing link to operator
//   npm run invite -- --list                   list every issued link + its status
//
// Dev mode grants the redeemer the on-page overlay (model + generation time;
// lib/devMode). Operator grants the redeemer /operator (the open-report queue
// + insight views; lib/operatorMode). Both grants are baked into the session
// cookie at redemption, so upgrading an already-redeemed link only takes
// effect once it is re-clicked.
//
// The printed base URL defaults to the production domain; override with
// PUBLIC_BASE_URL=https://… npm run invite -- "bob"
import { randomBytes } from "node:crypto";
import pg from "pg";

// Pull the --dev/--operator flags out first; the remaining args are the
// command / label.
const rawArgs = process.argv.slice(2);
const dev = rawArgs.includes("--dev");
const operator = rawArgs.includes("--operator");
const args = rawArgs.filter((a) => a !== "--dev" && a !== "--operator");
const arg = args[0];
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
      `SELECT token, label, dev_mode, operator, created_at, redeemed_at, redeemed_ip
         FROM access_tokens ORDER BY created_at DESC`,
    );
    if (rows.length === 0) {
      console.log("No invites issued yet.");
    }
    for (const r of rows) {
      const status = r.redeemed_at
        ? `last used ${new Date(r.redeemed_at).toISOString()}${r.redeemed_ip ? ` from ${r.redeemed_ip}` : ""}`
        : "unused";
      const tag = `${r.dev_mode ? " [dev]" : ""}${r.operator ? " [op]" : ""}`;
      console.log(
        `${(r.label ?? "(no label)").padEnd(16)} ${status.padEnd(48)} ${base}/api/access?invite=${r.token}${tag}`,
      );
    }
  } else if (arg === "--grant-dev") {
    const token = args[1];
    if (!token) {
      console.error("Usage: npm run invite -- --grant-dev <token>");
      process.exit(1);
    }
    const { rows } = await client.query(
      `UPDATE access_tokens SET dev_mode = true
         WHERE token = $1 RETURNING token, label`,
      [token],
    );
    if (rows.length === 0) {
      console.error(`No invite found for token ${token}`);
      process.exit(1);
    }
    console.log(
      `Granted dev mode to ${rows[0].label ?? "(no label)"}. Re-click the link to refresh the session:`,
    );
    console.log(`${base}/api/access?invite=${rows[0].token}`);
  } else if (arg === "--grant-operator") {
    const token = args[1];
    if (!token) {
      console.error("Usage: npm run invite -- --grant-operator <token>");
      process.exit(1);
    }
    const { rows } = await client.query(
      `UPDATE access_tokens SET operator = true
         WHERE token = $1 RETURNING token, label`,
      [token],
    );
    if (rows.length === 0) {
      console.error(`No invite found for token ${token}`);
      process.exit(1);
    }
    console.log(
      `Granted operator to ${rows[0].label ?? "(no label)"}. Re-click the link to refresh the session:`,
    );
    console.log(`${base}/api/access?invite=${rows[0].token}`);
  } else {
    const label = arg ?? null;
    // 128-bit token; the PK guarantees uniqueness — retry on the astronomically
    // unlikely collision rather than trusting entropy blindly. The link is
    // reusable, so one row can serve a person across all their devices.
    let token = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = randomBytes(16).toString("hex");
      const { rows } = await client.query(
        `INSERT INTO access_tokens (token, label, dev_mode, operator) VALUES ($1, $2, $3, $4)
           ON CONFLICT (token) DO NOTHING RETURNING token`,
        [candidate, label, dev, operator],
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
    const tag = `${dev ? " [dev]" : ""}${operator ? " [op]" : ""}`;
    console.log(`Invite link${label ? ` for ${label}` : ""}${tag} (reusable):`);
    console.log(`${base}/api/access?invite=${token}`);
  }
} finally {
  await client.end();
}
