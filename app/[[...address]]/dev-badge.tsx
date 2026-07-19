"use client";

import { useState } from "react";

/**
 * Dev-mode overlay (lib/devMode): a small, fixed-corner HUD shown only to
 * visitors with the dev grant — a dev-flagged invite, or local `next dev`. It
 * always reports the model that produced the page and, on a fresh
 * generation, the model that passed moderation plus how long generation and
 * moderation each took — reported separately rather than as one combined
 * total, since they're different calls (revisits show the generation model
 * only, since nothing else is persisted). When the
 * full prompt is available (fresh generation only — lib/resolvePage.ts never
 * reconstructs it for a revisit), the badge is clickable and expands into a
 * panel showing the levers and the exact prompt sent, seams and all under
 * book-v1 (docs/reference/generation.md).
 */
export function DevBadge({
  model,
  generationMs,
  moderationModel,
  moderationMs,
  prompt,
  promptVariant,
  form,
  temperature,
}: {
  model?: string | null;
  generationMs?: number;
  moderationModel?: string | null;
  moderationMs?: number;
  prompt?: string;
  promptVariant?: string;
  form?: string;
  temperature?: number;
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

  if (!prompt) {
    return (
      <div className="pointer-events-none fixed bottom-3 right-3 z-50 rounded bg-neutral-900/85 px-2 py-1 font-mono text-xs text-neutral-300 shadow-sm backdrop-blur-sm dark:bg-neutral-800/85">
        {summary}
      </div>
    );
  }

  return (
    <div className="fixed bottom-3 right-3 z-50 flex max-w-[min(32rem,calc(100vw-1.5rem))] flex-col items-end gap-1">
      {expanded && (
        <div className="max-h-[60vh] w-full overflow-auto rounded bg-neutral-900/95 p-3 font-mono text-xs text-neutral-300 shadow-sm backdrop-blur-sm dark:bg-neutral-800/95">
          <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-neutral-400">
            {promptVariant && (
              <>
                <dt>variant</dt>
                <dd>{promptVariant}</dd>
              </>
            )}
            {form && (
              <>
                <dt>form</dt>
                <dd>{form}</dd>
              </>
            )}
            {temperature != null && (
              <>
                <dt>temp</dt>
                <dd>{temperature.toFixed(2)}</dd>
              </>
            )}
          </dl>
          <pre className="whitespace-pre-wrap break-words text-neutral-100">{prompt}</pre>
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
