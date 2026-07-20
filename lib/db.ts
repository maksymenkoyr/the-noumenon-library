import { Pool } from "pg";
import { config } from "./config";
import { monitor } from "./monitor";

/**
 * Shared Postgres pool. DATABASE_URL is the only coupling to the provider:
 * local Postgres in dev, Neon's pooled (PgBouncer) connection string in
 * production (docs/reference/architecture.md §11). Pool size stays tiny because on
 * serverless each function instance gets its own pool.
 */
declare global {
  // Survives Next.js dev-server hot reloads, which re-evaluate modules.
  var __noumenonPool: Pool | undefined;
}

function getPool(): Pool {
  if (!globalThis.__noumenonPool) {
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: 3,
    });
    // pg emits 'error' on idle clients when the backend drops the connection
    // (routine with Neon's scale-to-zero / idle timeouts); without a listener
    // that event is an uncaught exception that can crash the process. The
    // client is already removed from the pool at that point, so logging is
    // all that's left to do.
    pool.on("error", (err) => {
      console.warn("[noumenon] idle DB client error (non-fatal):", err.message);
    });
    globalThis.__noumenonPool = pool;
  }
  return globalThis.__noumenonPool;
}

export async function query<Row extends object = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<Row[]> {
  try {
    const result = await getPool().query(text, params);
    return result.rows as Row[];
  } catch (error) {
    // The store is the library's only source of truth (§9) — surface DB failures
    // as a structured, alertable event. Re-throw so callers behave unchanged.
    await monitor("db_query_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Close the shared pool (tests and scripts; never called per-request). */
export async function closePool(): Promise<void> {
  if (globalThis.__noumenonPool) {
    await globalThis.__noumenonPool.end();
    globalThis.__noumenonPool = undefined;
  }
}
