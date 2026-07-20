import { createHash } from "node:crypto";
import { config } from "./config";

/**
 * Hash a client IP before it touches the store. The IP is the only
 * quasi-identifier any write path sees, and it is never persisted in the clear
 * (docs/reference/architecture.md §12, docs/reference/legal.md). The salt (RATE_LIMIT_SALT) blocks
 * reversing the hash via a rainbow table of the small address space.
 *
 * Shared by every IP-keyed throttle: generation admission (lib/economics.ts)
 * and reader-signal writes (lib/engagement.ts).
 */

// One loud warning per process when production hashes are unsalted — a bare
// sha256 over the ~4B IPv4 space is trivially reversible by brute force,
// which defeats the "not reversible to the IP" posture above. Same
// once-per-process pattern as lib/moderate.ts's disabled-gate warning.
let warnedUnsalted = false;
function warnUnsalted(): void {
  if (warnedUnsalted || !config.isProduction) return;
  warnedUnsalted = true;
  console.warn(
    "[noumenon] ⚠ RATE_LIMIT_SALT is unset — stored IP hashes are unsalted and effectively reversible; set a salt in production",
  );
}

export function ipHash(ip: string): string {
  if (!config.rateLimitSalt) warnUnsalted();
  return createHash("sha256").update(config.rateLimitSalt + ip).digest("hex");
}
