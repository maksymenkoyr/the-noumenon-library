import { headers } from "next/headers";

/**
 * Best-effort client IP for rate-limit keying (docs/reference/architecture.md §10, §12).
 * Lives in the app/request layer so resolvePage stays framework-free and unit
 * testable; the raw IP is hashed before it touches the store (lib/economics.ts).
 *
 * `x-forwarded-for`'s leftmost entry is client-supplied and trivially spoofed —
 * Vercel appends the real connecting address rather than replacing the header,
 * so `X-Forwarded-For: <anything>` from the client mints a fresh rate-limit
 * identity on every request. `x-real-ip` is the platform-set, un-spoofable
 * connecting address, so it's the trusted source; XFF is only a fallback (e.g.
 * non-Vercel deploys), and even then we take the *last* hop — the one appended
 * by our own trusted proxy — never the client-controlled first one. Returns
 * undefined when neither header is present (e.g. a local direct hit) — the
 * rate limiter then simply doesn't apply, rather than keying every anonymous
 * visitor together.
 */
export async function getClientIp(): Promise<string | undefined> {
  const h = await headers();
  const realIp = h.get("x-real-ip");
  if (realIp) return realIp.trim() || undefined;

  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    return hops[hops.length - 1];
  }
  return undefined;
}
