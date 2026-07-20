/**
 * Coarse device classification from a User-Agent string
 * (app/api/engagement/route.ts, lib/engagement.ts recordEvents). Deliberately
 * throws away everything except a broad class — the raw UA string is never
 * stored (docs/reference/legal.md: no user identifiers, and a full UA is
 * itself fingerprint-y). Regex-only, no dependency, best-effort by nature.
 */

export type DeviceClass = "mobile" | "tablet" | "desktop";

// Checked first: iPad/Android-tablet UAs would otherwise trip the mobile
// pattern below. Android tablets omit "Mobile" from their UA entirely, so a
// bare "Android" with no later "Mobile" token reads as a tablet.
const TABLET_RE = /iPad|Tablet|Android(?!.*Mobile)/i;

// iPhone/iPod always carry their own token; Android phones and most other
// mobile browsers advertise a "Mobile" token somewhere in the string.
const MOBILE_RE = /iPhone|iPod|Windows Phone|Mobile/i;

export function deviceClass(
  userAgent: string | null | undefined,
): DeviceClass | null {
  if (!userAgent) return null;
  if (TABLET_RE.test(userAgent)) return "tablet";
  if (MOBILE_RE.test(userAgent)) return "mobile";
  return "desktop";
}
