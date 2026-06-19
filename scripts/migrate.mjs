// Apply lib/schema.sql to DATABASE_URL. Idempotent.
// Usage: npm run db:migrate   (loads .env.local via node --env-file)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const schemaPath = fileURLToPath(new URL("../lib/schema.sql", import.meta.url));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(readFileSync(schemaPath, "utf8"));
  console.log(`Schema applied to ${new URL(databaseUrl).host}`);
} finally {
  await client.end();
}
