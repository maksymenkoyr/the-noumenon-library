import { NextResponse } from "next/server";
import { formatAddress, randomAddress } from "@/lib/address";
import { getClientIp } from "@/lib/clientIp";
import { getDevMode } from "@/lib/devMode";
import { resolvePage } from "@/lib/resolvePage";

export const runtime = "nodejs";
export const maxDuration = 60; // Hobby cap; generations run 8–32s

/**
 * Dev-only debug endpoint: resolves a random address and returns the full
 * prompt/model/timing detail (app/[[...address]]/dev-badge draws on the same
 * shape client-side). It burns a real paid generation per call and has no
 * auth of its own beyond the access gate — fine while the site is
 * invite-only, but a free budget drain and prompt leak once the gate opens
 * for public launch. 404 (not 401/403) for non-disclosure, same pattern as
 * app/api/operator/resolve.
 */
export async function GET() {
  if (!(await getDevMode())) return new NextResponse(null, { status: 404 });

  const address = formatAddress(randomAddress());
  const {
    status,
    text,
    model,
    generationMs,
    moderationMs,
    moderationModel,
    prompt,
    promptSegments,
    promptVariant,
  } = await resolvePage(address, { clientIp: await getClientIp() });
  return NextResponse.json({
    address,
    status,
    text,
    model,
    generationMs,
    moderationMs,
    moderationModel,
    prompt,
    promptSegments,
    promptVariant,
  });
}
