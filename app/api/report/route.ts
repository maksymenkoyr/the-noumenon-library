import { NextResponse, after } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/clientIp";
import { admitEngagementWrite, canonicalizeAddress } from "@/lib/engagement";
import { monitor } from "@/lib/monitor";
import { sendReportEmail } from "@/lib/reportEmail";
import { recordReport } from "@/lib/reports";

/**
 * File a content report against a committed leaf. The row lands in the
 * operator's queue (page_reports, reviewed on /operator) regardless of what
 * happens to the notification side-channels — email via after() so it runs
 * once the response has flushed (a bare floating promise can be killed when a
 * serverless response ends), and only for the first open report on an address
 * so a hot page can't flood the inbox. Same admission as the other reader
 * signals: hashed-IP throttle, no identifiers stored (docs/reference/legal.md).
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { address, reason } = (body ?? {}) as {
    address?: unknown;
    reason?: unknown;
  };
  const canonical = canonicalizeAddress(address);
  if (!canonical || (reason !== undefined && typeof reason !== "string")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const clientIp = await getClientIp();
  if (!(await admitEngagementWrite(clientIp))) {
    return NextResponse.json({ ok: false });
  }

  let firstOpenForAddress: boolean;
  try {
    ({ firstOpenForAddress } = await recordReport(canonical, reason));
  } catch {
    // Most likely the pages FK — a report forged against an address that was
    // never committed. Nothing to review, nothing to store.
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  after(async () => {
    await monitor("page_reported", { address: canonical });
    if (firstOpenForAddress) {
      // Same truncation the store applies (lib/reports.ts).
      await sendReportEmail({
        address: canonical,
        reason: reason?.trim().slice(0, 500) || null,
      });
    }
  });

  return NextResponse.json({ ok: true });
}
