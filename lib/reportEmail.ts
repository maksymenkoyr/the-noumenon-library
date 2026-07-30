import { config } from "./config";
import { monitor } from "./monitor";

/**
 * Operator email for a new content report — one HTTPS POST to Resend, plain
 * fetch, no SDK (same shape as the monitor webhook, lib/monitor.ts; SMTP would
 * mean a socket handshake per serverless invocation). Best-effort and
 * fail-open like all alerting here: unset env (dev default) or a failed send
 * must never affect the stored report or the caller. The body carries only
 * the address and the reader's reason — nothing about the reporter
 * (docs/reference/legal.md).
 */
export async function sendReportEmail(report: {
  address: string;
  reason: string | null;
}): Promise<void> {
  const apiKey = config.resendApiKey;
  const to = config.reportNotifyEmail;
  if (!apiKey || !to) return;

  const text = [
    `Address: ${report.address}`,
    `Reason: ${report.reason ?? "(none given)"}`,
    "",
    "Review at /operator; removal, if warranted, via `npm run takedown`.",
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.reportFromEmail,
        to: [to],
        subject: `Noumenon Library report: ${report.address}`,
        text,
      }),
    });
    if (!res.ok) {
      // A rejected send (bad sender domain, revoked key, ...) is otherwise
      // silent — the report row is already stored either way, so this is
      // visibility only, not a retry.
      await monitor("report_email_failed", {
        address: report.address,
        status: res.status,
      });
    }
  } catch (err) {
    // Best-effort — the report row is already stored; swallow, but still
    // surface it the same way a rejected response would be.
    await monitor("report_email_failed", {
      address: report.address,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
