"use client";

import { useState } from "react";
import type { ModelProposal } from "@/lib/modelProposals";

/**
 * The model-pool decision queue (/operator). The daily review job proposes;
 * this is where a human says yes or no.
 *
 * Deliberately not a one-click "apply everything": each row is checked
 * individually and the reasoning that earned it a place is printed next to it,
 * because applying one of these changes which models write the library. The
 * Telegram digest carries the same text, so the decision can be made on a
 * phone and executed here without re-reading anything.
 */

const INFORMATIONAL = new Set(["swap"]);

function summarise(payload: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof payload.pricePerMillion === "number") {
    bits.push(`$${payload.pricePerMillion.toFixed(2)}/M`);
  }
  if (typeof payload.weight === "number") bits.push(`weight ${payload.weight}`);
  if (typeof payload.trialDays === "number") bits.push(`${payload.trialDays}d trial`);
  if (typeof payload.extendDays === "number") bits.push(`+${payload.extendDays}d`);
  if (typeof payload.contextLength === "number") {
    bits.push(`${Math.round(payload.contextLength / 1000)}k ctx`);
  }
  return bits.join(" · ");
}

export function ProposalsPanel({ proposals }: { proposals: ModelProposal[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: number) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function decide(decision: "apply" | "reject") {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/apply-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selected], decision }),
      });
      if (!response.ok) {
        setError(`request failed (${response.status})`);
        setBusy(false);
        return;
      }
      const result = (await response.json()) as {
        skipped?: { id: number; reason: string }[];
      };
      // Skips are the interesting outcome — a refused change must never look
      // like a successful one, so surface it instead of reloading past it.
      if (result.skipped && result.skipped.length > 0) {
        setError(`skipped: ${result.skipped.map((s) => s.reason).join("; ")}`);
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      setError("network error");
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 font-mono text-sm text-neutral-500">
      <h2 className="text-neutral-800 dark:text-neutral-200">
        model pool proposals ({proposals.length})
      </h2>

      {proposals.length === 0 ? (
        <p>nothing pending. the daily review found no changes worth asking about.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {proposals.map((proposal) => {
              const informational = INFORMATIONAL.has(proposal.action);
              const details = summarise(proposal.payload);
              return (
                <li key={proposal.id} className="flex items-baseline gap-3">
                  <input
                    type="checkbox"
                    id={`proposal-${proposal.id}`}
                    checked={selected.has(proposal.id)}
                    onChange={() => toggle(proposal.id)}
                    className="shrink-0"
                  />
                  <label
                    htmlFor={`proposal-${proposal.id}`}
                    className="flex min-w-0 flex-1 flex-col gap-0.5"
                  >
                    <span className="text-neutral-800 dark:text-neutral-200">
                      {informational ? "⚠ " : ""}
                      {proposal.action} · {proposal.slug}{" "}
                      <span className="text-neutral-500">({proposal.task})</span>
                    </span>
                    <span className="text-neutral-500">{proposal.reason}</span>
                    {details && <span className="text-neutral-400">{details}</span>}
                  </label>
                </li>
              );
            })}
          </ul>

          <div className="flex items-baseline gap-4">
            <button
              type="button"
              onClick={() => decide("apply")}
              disabled={busy || selected.size === 0}
              className="text-neutral-400 hover:text-neutral-800 disabled:opacity-40 dark:text-neutral-600 dark:hover:text-neutral-200"
            >
              apply {selected.size > 0 ? `(${selected.size})` : ""}
            </button>
            <button
              type="button"
              onClick={() => decide("reject")}
              disabled={busy || selected.size === 0}
              className="text-neutral-400 hover:text-neutral-800 disabled:opacity-40 dark:text-neutral-600 dark:hover:text-neutral-200"
            >
              dismiss
            </button>
            {error && <span className="text-neutral-800 dark:text-neutral-200">{error}</span>}
          </div>
        </>
      )}
    </section>
  );
}
