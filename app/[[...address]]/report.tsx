"use client";

import { useState, useSyncExternalStore } from "react";

/**
 * The content-report affordance for a committed leaf (docs/legal.md): a quiet
 * `report` control that expands to an optional one-line reason, POSTing to
 * /api/report — the row lands in the operator's queue whatever happens to the
 * notification email. The mailto link stays beside it as the manual channel
 * (email-only intake predates this control and remains valid).
 *
 * Acknowledged state is remembered per-address in localStorage so a revisit
 * doesn't invite duplicate reports; like every reader mark it's this browser
 * only, nothing identifying is sent (docs/legal.md).
 */

const reportedKey = (address: string) => `noumenon:reported:${address}`;
const REPORT_EVENT = "noumenon:reported-change";

function readReported(address: string): boolean {
  try {
    return localStorage.getItem(reportedKey(address)) !== null;
  } catch {
    return false;
  }
}

function writeReported(address: string): void {
  try {
    localStorage.setItem(reportedKey(address), String(Date.now()));
  } catch {
    /* non-fatal */
  }
  window.dispatchEvent(new Event(REPORT_EVENT));
}

// Same useSyncExternalStore idiom as the leaf marks: stable `false` server
// snapshot (no hydration mismatch), re-render on our own writes and cross-tab.
function useReported(address: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(REPORT_EVENT, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        window.removeEventListener(REPORT_EVENT, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    () => readReported(address),
    () => false,
  );
}

export function Report({
  address,
  contactEmail,
}: {
  address: string;
  contactEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reported = useReported(address);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setOpen(false);
    writeReported(address); // flips `reported` via the external store
    fetch("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
      keepalive: true,
    }).catch(() => {
      /* best-effort; the operator mailto remains */
    });
  }

  return (
    <div className="font-mono text-sm text-neutral-400 dark:text-neutral-600">
      {reported ? (
        <span>reported — thank you</span>
      ) : open ? (
        <form onSubmit={submit} className="flex min-w-0 items-center gap-2">
          <input
            aria-label="Reason (optional)"
            placeholder="reason (optional)"
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            className="min-w-0 flex-1 border-b border-neutral-300 bg-transparent pb-0.5 outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
          />
          <button
            type="submit"
            className="shrink-0 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            send
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="shrink-0 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            cancel
          </button>
        </form>
      ) : (
        <span className="flex items-baseline gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            report
          </button>
          {contactEmail && (
            <a
              href={`mailto:${contactEmail}?subject=Noumenon%20Library%20report%3A%20${encodeURIComponent(address)}`}
              className="hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              or email
            </a>
          )}
        </span>
      )}
    </div>
  );
}
