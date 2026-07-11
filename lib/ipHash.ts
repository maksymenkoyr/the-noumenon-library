import { createHash } from "node:crypto";
import { config } from "./config";

/**
 * Hash a client IP before it touches the store. The IP is the only
 * quasi-identifier any write path sees, and it is never persisted in the clear
 * (docs/architecture.md §12, docs/legal.md). The salt (RATE_LIMIT_SALT) blocks
 * reversing the hash via a rainbow table of the small address space.
 *
 * Shared by every IP-keyed throttle: generation admission (lib/economics.ts)
 * and reader-signal writes (lib/engagement.ts).
 */
export function ipHash(ip: string): string {
  return createHash("sha256").update(config.rateLimitSalt + ip).digest("hex");
}
