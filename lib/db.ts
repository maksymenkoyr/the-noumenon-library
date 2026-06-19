import { Pool } from "pg";
import { config } from "./config";

/**
 * Shared Postgres pool. DATABASE_URL is the only coupling to the provider:
 * local Postgres in dev, Neon's pooled (PgBouncer) connection string in
 * production (docs/architecture.md §11). Pool size stays tiny because on
 * serverless each function instance gets its own pool.
 */
declare global {
  // Survives Next.js dev-server hot reloads, which re-evaluate modules.
  var __noumenonPool: Pool | undefined;
}

function getPool(): Pool {
  if (!globalThis.__noumenonPool) {
    globalThis.__noumenonPool = new Pool({
      connectionString: config.databaseUrl,
      max: 3,
    });
  }
  return globalThis.__noumenonPool;
}

export async function query<Row extends object = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const result = await getPool().query(text, params);
  return result.rows as Row[];
}

/** Close the shared pool (tests and scripts; never called per-request). */
export async function closePool(): Promise<void> {
  if (globalThis.__noumenonPool) {
    await globalThis.__noumenonPool.end();
    globalThis.__noumenonPool = undefined;
  }
}
