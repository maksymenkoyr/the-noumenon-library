import { NextResponse } from "next/server";
import { formatAddress, randomAddress } from "@/lib/address";
import { getClientIp } from "@/lib/clientIp";
import { resolvePage } from "@/lib/resolvePage";

export const runtime = "nodejs";
export const maxDuration = 60; // Hobby cap; generations run 8–32s

export async function GET() {
  const address = formatAddress(randomAddress());
  const {
    status,
    text,
    model,
    generationMs,
    moderationMs,
    moderationModel,
    prompt,
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
    promptVariant,
  });
}
