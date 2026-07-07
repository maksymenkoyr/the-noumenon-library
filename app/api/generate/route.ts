import { NextResponse } from "next/server";
import { formatAddress, randomAddress } from "@/lib/address";
import { getClientIp } from "@/lib/clientIp";
import { resolvePage } from "@/lib/resolvePage";

export const runtime = "nodejs";

export async function GET() {
  const address = formatAddress(randomAddress());
  const { status, text } = await resolvePage(address, {
    clientIp: await getClientIp(),
  });
  return NextResponse.json({ address, status, text });
}
