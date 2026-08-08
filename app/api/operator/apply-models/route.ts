import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, readSessionClaims } from "@/lib/access";
import { config } from "@/lib/config";
import { decideProposals } from "@/lib/modelProposals";

/**
 * Act on model-pool proposals raised by the daily review job (app/operator,
 * lib/modelProposals). Re-verifies the operator claim server-side from the
 * session cookie — never trust the client that rendered the page — and 404s on
 * failure, the same non-disclosure as the page itself (lib/operatorMode): a
 * non-operator, or the gate being inert, must see no evidence this route
 * exists.
 *
 * This is the most consequential operator action in the app: it changes which
 * models write the library. Hence the ceiling on `ids` below, and the
 * generation-floor backstop inside decideProposals().
 */
export const runtime = "nodejs";

/**
 * A single run proposes a handful of changes (the job caps candidates at 3).
 * Anything near this is a malformed or hostile body, not a real decision.
 */
const MAX_IDS = 100;

export async function POST(request: NextRequest) {
  const secret = config.accessSigningSecret;
  if (!secret) return new NextResponse(null, { status: 404 });

  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  const claims = await readSessionClaims(secret, cookie);
  if (claims?.operator !== true) return new NextResponse(null, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { ids, decision } = (body ?? {}) as { ids?: unknown; decision?: unknown };

  if (decision !== "apply" && decision !== "reject") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!ids.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await decideProposals(ids as number[], decision);
  return NextResponse.json(result);
}
