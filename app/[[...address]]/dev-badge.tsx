"use client";

import { Fragment, useState } from "react";
import type { PromptSegment } from "@/lib/prompts";

/**
 * Dev-mode overlay (lib/devMode): a small, fixed-corner HUD shown only to
 * visitors with the dev grant — a dev-flagged invite, or local `next dev`. It
 * always reports the model that produced the page and, on a fresh
 * generation, the model that passed moderation plus how long generation and
 * moderation each took — reported separately rather than as one combined
 * total, since they're different calls. When the prompt is available (read back
 * from the stored inputs record, so revisits included), the badge is clickable
 * and expands into a panel showing the levers and the prompt
 * (docs/reference/generation.md).
 *
 * The prompt is shown as its labeled parts — framing, length rule, one row per
 * sampled constraint — rather than one glued-together blob, so prompt iteration
 * can see at a glance which dials actually fired. Rows committed before
 * segments were tracked carry only the flat string and degrade to a single
 * block.
 */
export function DevBadge({
  model,
  generationMs,
  moderationModel,
  moderationMs,
  prompt,
  promptSegments,
  promptVariant,
  temperature,
  provider,
  maxTokens,
}: {
  model?: string | null;
  generationMs?: number;
  moderationModel?: string | null;
  moderationMs?: number;
  prompt?: string;
  promptSegments?: PromptSegment[];
  promptVariant?: string;
  temperature?: number;
  provider?: string;
  maxTokens?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!model && generationMs == null && moderationMs == null) return null;

  const summary = (
    <>
      {model ?? "unknown model"}
      {generationMs != null && ` · gen ${(generationMs / 1000).toFixed(1)}s`}
      {moderationModel && ` · mod: ${moderationModel}`}
      {moderationMs != null && ` (${(moderationMs / 1000).toFixed(1)}s)`}
    </>
  );

  const segments = promptSegments?.length ? promptSegments : undefined;
  if (!segments && !prompt) {
    return (
      <div className="pointer-events-none fixed bottom-3 right-3 z-50 rounded bg-neutral-900/85 px-2 py-1 font-mono text-xs text-neutral-300 shadow-sm backdrop-blur-sm dark:bg-neutral-800/85">
        {summary}
      </div>
    );
  }

  const levers: [string, string | undefined][] = [
    ["provider", provider],
    ["variant", promptVariant],
    ["temp", temperature?.toFixed(2)],
    ["max tok", maxTokens?.toString()],
  ];

  return (
    <div className="fixed bottom-3 right-3 z-50 flex max-w-[min(32rem,calc(100vw-1.5rem))] flex-col items-end gap-1">
      {expanded && (
        <div className="max-h-[60vh] w-full overflow-auto rounded bg-neutral-900/95 p-3 font-mono text-xs text-neutral-300 shadow-sm backdrop-blur-sm dark:bg-neutral-800/95">
          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-neutral-400">
            {levers.map(([label, value]) =>
              value == null ? null : (
                <Fragment key={label}>
                  <dt>{label}</dt>
                  <dd className="break-all">{value}</dd>
                </Fragment>
              ),
            )}
          </dl>
          {segments ? (
            <div className="flex flex-col gap-2.5">
              {segments.map((seg, i) => (
                // Plain divs, not a heading/section: this is a debug overlay
                // and must stay out of the page's document outline.
                <div key={`${seg.id}-${i}`}>
                  <div className="mb-0.5 flex items-baseline gap-1.5 text-[0.6875rem] uppercase tracking-wide text-neutral-500">
                    <span className="text-neutral-400">{seg.id}</span>
                    {seg.probability != null && <span>p={seg.probability}</span>}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-neutral-100">{seg.text}</p>
                </div>
              ))}
            </div>
          ) : (
            // Pre-segment rows carry only the assembled string.
            <pre className="whitespace-pre-wrap break-words text-neutral-100">{prompt}</pre>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="rounded bg-neutral-900/85 px-2 py-1 font-mono text-xs text-neutral-300 shadow-sm backdrop-blur-sm hover:text-neutral-100 dark:bg-neutral-800/85"
      >
        {summary}
      </button>
    </div>
  );
}
