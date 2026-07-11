import { config } from "./config";

/**
 * Operator email for a new content report — one HTTPS POST to Resend, plain
 * fetch, no SDK (same shape as the monitor webhook, lib/monitor.ts; SMTP would
 * mean a socket handshake per serverless invocation). Best-effort and
 * fail-open like all alerting here: unset env (dev default) or a failed send
 * must never affect the stored report or the caller. The body carries only
 * the address and the reader's reason — nothing about the reporter
 * (docs/legal.md).
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
    await fetch("https://api.resend.com/emails", {
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
  } catch {
    // Best-effort — the report row is already stored; swallow.
  }
}
