import { headers } from "next/headers";

/**
 * Best-effort client IP for rate-limit keying (docs/reference/architecture.md §10, §12).
 * Lives in the app/request layer so resolvePage stays framework-free and unit
 * testable; the raw IP is hashed before it touches the store (lib/economics.ts).
 *
 * On Vercel the edge sets `x-forwarded-for` (client first, then proxies) and
 * `x-real-ip`. Returns undefined when neither is present (e.g. a local direct
 * hit) — the rate limiter then simply doesn't apply, rather than keying every
 * anonymous visitor together.
 */
export async function getClientIp(): Promise<string | undefined> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || undefined;
  return h.get("x-real-ip") ?? undefined;
}
