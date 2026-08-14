"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * The content-report affordance for a committed page (docs/reference/legal.md): a quiet
 * `report` control that expands to an optional one-line reason, POSTing to
 * /api/report — the row lands in the operator's queue whatever happens to the
 * notification email. The mailto link stays beside it as the manual channel
 * (email-only intake predates this control and remains valid).
 *
 * Acknowledged state is remembered per-address in localStorage so a revisit
 * doesn't invite duplicate reports; like every reader mark it's this browser
 * only, nothing identifying is sent (docs/reference/legal.md).
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

// Same useSyncExternalStore idiom as the page marks: stable `false` server
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
  const [sending, setSending] = useState(false);
  const reported = useReported(address);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  // Tracks whether `open` just fell from true — distinct from the initial
  // `false` on mount, which must not steal focus onto the trigger.
  const wasOpenRef = useRef(false);

  // Move focus into the form when it opens, and back to the `report` button
  // when it closes without a report having landed (i.e. cancel) — imperative
  // rather than an `autoFocus` prop (jsx-a11y/no-autofocus) so it only fires
  // on this deliberate user action, never on initial mount. On a real
  // success the trigger no longer renders (the `reported` branch takes
  // over), so the ref is null and the restore is a no-op.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      reasonRef.current?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setSending(true);
    fetch("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
      keepalive: true,
    })
      .then(async (res) => {
        // Only claim success once the server has actually accepted the
        // report — an access-gate 401, a bad-address 400, or a throttled
        // `{ok:false}` (still HTTP 200, app/api/report/route.ts) must not
        // render the same "thank you" as a real insert, or the reader (and
        // this browser, forever) never finds out it didn't land.
        if (!res.ok) return;
        const body: unknown = await res.json().catch(() => null);
        if ((body as { ok?: boolean } | null)?.ok) {
          setOpen(false);
          writeReported(address); // flips `reported` via the external store
        }
      })
      .catch(() => {
        /* best-effort; the operator mailto remains */
      })
      .finally(() => setSending(false));
  }

  return (
    <div className="font-mono text-sm text-neutral-400 dark:text-neutral-600">
      {reported ? (
        <span role="status">reported — thank you</span>
      ) : open ? (
        <form onSubmit={submit} className="flex min-w-0 items-center gap-2">
          <input
            ref={reasonRef}
            aria-label="Reason (optional)"
            placeholder="reason (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            disabled={sending}
            className="min-w-0 flex-1 border-b border-neutral-300 bg-transparent pb-0.5 placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
          />
          <button
            type="submit"
            disabled={sending}
            className="shrink-0 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            {sending ? "sending…" : "send"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={sending}
            className="shrink-0 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            cancel
          </button>
        </form>
      ) : (
        <span className="flex items-baseline gap-2">
          <button
            ref={triggerRef}
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
