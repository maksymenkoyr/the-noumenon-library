/**
 * Dev-mode overlay (lib/devMode): a small, fixed-corner HUD shown only to
 * visitors with the dev grant — a dev-flagged invite, or local `next dev`. For
 * now it reports the model that produced the page and, on a fresh generation,
 * how long it took (revisits show model only, since duration is not persisted).
 * Fixed-positioned so it never shifts the leaf; built to grow (temperature,
 * form, cost) without touching callers.
 */
export function DevBadge({
  model,
  durationMs,
}: {
  model?: string | null;
  durationMs?: number;
}) {
  if (!model && durationMs == null) return null;
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-50 rounded bg-neutral-900/85 px-2 py-1 font-mono text-xs text-neutral-300 shadow-sm backdrop-blur-sm dark:bg-neutral-800/85">
      {model ?? "unknown model"}
      {durationMs != null && ` · ${(durationMs / 1000).toFixed(1)}s`}
    </div>
  );
}
