"use client";

/**
 * Acknowledge one open report (/operator queue). Resolving is only an
 * acknowledgement, not a takedown (scripts/takedown.mjs stays the removal
 * tool) — a plain reload after the POST is enough; there's no local state to
 * reconcile.
 */
export function ResolveButton({ id }: { id: number }) {
  async function resolve() {
    await fetch("/api/operator/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {
      /* best-effort; a stuck row is just re-clicked */
    });
    window.location.reload();
  }

  return (
    <button
      type="button"
      onClick={resolve}
      className="shrink-0 text-neutral-400 hover:text-neutral-800 dark:text-neutral-600 dark:hover:text-neutral-200"
    >
      resolve
    </button>
  );
}
