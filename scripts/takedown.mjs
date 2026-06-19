// Reactive takedown (docs/legal.md): blank an address by report.
// Usage: npm run takedown -- <address>     e.g. npm run takedown -- io-9/3/2/17/308
//
// Upserts a `taken_down` row so it works whether or not the page was ever
// generated (pre-emptive blocks). Run as a script, not an HTTP endpoint —
// there is no admin auth, so an open takedown route would be an abuse vector.
import pg from "pg";

const address = process.argv[2];
if (!address) {
  console.error("Usage: npm run takedown -- <address>");
  process.exit(1);
}
// Light shape check (full normalization lives in lib/address.ts). The operator
// passes the canonical address shown in the UI.
if (!/^[a-z0-9-]+\/\d+\/\d+\/\d+\/\d+$/.test(address)) {
  console.error(`Address does not look canonical: ${address}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(
    `INSERT INTO pages (address, status, committed_at)
     VALUES ($1, 'taken_down', now())
     ON CONFLICT (address) DO UPDATE SET
       status = 'taken_down',
       content = NULL,
       content_hash = NULL,
       committed_at = now()`,
    [address],
  );
  console.log(`Taken down: ${address}`);
} finally {
  await client.end();
}
