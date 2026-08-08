import { query } from "./db";
import { monitor } from "./monitor";
import type { ProposalAction } from "./modelReview";

/**
 * The operator's decision queue for model-pool changes (app/operator).
 *
 * The daily job (scripts/review-models.ts) writes here rather than acting,
 * for everything that would grow the pool or spend more money. The digest
 * Telegram sends and the panel rendered on /operator are the same rows, so
 * what the message described is exactly what the Apply button applies.
 *
 * Deciding is a one-way door per row: 'pending' → 'applied' | 'rejected', or
 * 'superseded' when the next run replaces it. Decided rows are kept as the
 * audit trail of what the pool was asked to become and what a human said back.
 */

export type ProposalStatus = "pending" | "applied" | "rejected" | "superseded";

export interface ModelProposal {
  id: number;
  runId: string;
  createdAt: Date;
  slug: string;
  provider: "openrouter" | "google";
  task: "generation" | "moderation";
  action: ProposalAction;
  reason: string;
  payload: Record<string, unknown>;
}

interface ProposalRow {
  id: string;
  run_id: string;
  created_at: Date;
  slug: string;
  provider: "openrouter" | "google";
  task: "generation" | "moderation";
  action: ProposalAction;
  reason: string;
  payload: Record<string, unknown>;
}

function toProposal(row: ProposalRow): ModelProposal {
  return {
    id: Number(row.id),
    runId: row.run_id,
    createdAt: row.created_at,
    slug: row.slug,
    provider: row.provider,
    task: row.task,
    action: row.action,
    reason: row.reason,
    payload: row.payload ?? {},
  };
}

/**
 * Actions that carry no automatic edit. `swap` says a provider is retiring a
 * model we run — true, urgent, and not something a checkbox can resolve, since
 * choosing the replacement is the actual decision. Surfaced for the human,
 * dismissible once acted on, never silently "applied".
 */
export const INFORMATIONAL_ACTIONS: ReadonlySet<string> = new Set(["swap"]);

export async function listPendingProposals(): Promise<ModelProposal[]> {
  const rows = await query<ProposalRow>(
    `SELECT id, run_id, created_at, slug, provider, task, action, reason, payload
       FROM model_proposals
      WHERE status = 'pending'
      ORDER BY created_at DESC, id ASC`,
    [],
    "modelProposals.listPendingProposals",
  );
  return rows.map(toProposal);
}

function numberFrom(payload: Record<string, unknown>, key: string): number | null {
  const value = Number(payload[key]);
  return Number.isFinite(value) ? value : null;
}

/**
 * How many generation models would still be selectable if `pending` more were
 * turned off. The daily job has its own floor guard, but that one only governs
 * what it does unattended — this is the backstop for the dashboard, where a
 * careless "select all" on a run full of escalations could otherwise take the
 * library dark in one click. One model is the absolute minimum; deliberately
 * going below it stays possible, just not through a checkbox.
 */
async function enabledGenerationCount(): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT count(*) AS count FROM model_registry
      WHERE task = 'generation' AND enabled = true
        AND (expires_at IS NULL OR expires_at > now())`,
    [],
    "modelProposals.enabledGenerationCount",
  );
  return Number(rows[0]?.count ?? 0);
}

/** Does applying this proposal remove a generation model from selection? */
function removesGenerationModel(proposal: ModelProposal): boolean {
  return (
    proposal.task === "generation" &&
    (proposal.action === "disable" || proposal.action === "drop_trial")
  );
}

async function applyOne(proposal: ModelProposal): Promise<void> {
  const { slug, provider, task, payload } = proposal;

  switch (proposal.action) {
    case "add_trial": {
      const weight = numberFrom(payload, "weight") ?? 5;
      const days = numberFrom(payload, "trialDays") ?? 14;
      const price = numberFrom(payload, "pricePerMillion");
      // ON CONFLICT DO UPDATE, not DO NOTHING: a slug that was tried before
      // and dropped still has its row, and a plain insert would silently do
      // nothing while reporting success. baseline_price is stamped to today's
      // price here — this is the moment we chose the model, which is exactly
      // what the spike guard should measure future prices against.
      await query(
        `INSERT INTO model_registry
           (slug, provider, task, enabled, weight, temperature, max_tokens,
            reasoning_enabled, price_per_million, baseline_price, price_checked_at,
            trial, expires_at)
         VALUES ($1, $2, $3, true, $4, 0.9, 1000, false, $5, $5, now(), true,
                 now() + ($6 || ' days')::interval)
         ON CONFLICT (slug, task) DO UPDATE SET
           enabled           = true,
           weight            = EXCLUDED.weight,
           price_per_million = EXCLUDED.price_per_million,
           baseline_price    = EXCLUDED.baseline_price,
           price_checked_at  = now(),
           trial             = true,
           expires_at        = EXCLUDED.expires_at,
           health            = 'ok',
           cooling_until     = NULL`,
        [slug, provider, task, weight, price, String(days)],
        "modelProposals.addTrial",
      );
      return;
    }

    case "promote_trial": {
      const weight = numberFrom(payload, "weight") ?? 10;
      // Clearing expires_at is the promotion: the row stops being on a clock.
      await query(
        `UPDATE model_registry
            SET trial = false, expires_at = NULL, weight = $3
          WHERE slug = $1 AND task = $2`,
        [slug, task, weight],
        "modelProposals.promoteTrial",
      );
      return;
    }

    case "extend_trial": {
      const days = numberFrom(payload, "extendDays") ?? 14;
      // Extend from now rather than from the old expiry, so a proposal acted
      // on late still buys the full window it promised.
      await query(
        `UPDATE model_registry
            SET expires_at = now() + ($3 || ' days')::interval
          WHERE slug = $1 AND task = $2`,
        [slug, task, String(days)],
        "modelProposals.extendTrial",
      );
      return;
    }

    case "drop_trial":
    case "disable": {
      await query(
        `UPDATE model_registry SET enabled = false WHERE slug = $1 AND task = $2`,
        [slug, task],
        "modelProposals.disable",
      );
      return;
    }

    case "reprice_baseline": {
      const price = numberFrom(payload, "baselinePrice");
      if (price === null) return;
      await query(
        `UPDATE model_registry SET baseline_price = $3 WHERE slug = $1 AND task = $2`,
        [slug, task, price],
        "modelProposals.repriceBaseline",
      );
      return;
    }

    default:
      // Informational only (see INFORMATIONAL_ACTIONS) — nothing to write.
      return;
  }
}

export interface DecisionResult {
  applied: number[];
  rejected: number[];
  skipped: { id: number; reason: string }[];
}

/**
 * Act on a set of proposals. `decision` is the operator's verdict for all of
 * them: `apply` performs the change, `reject` records that they looked and
 * said no.
 *
 * Each proposal is written and marked in sequence rather than in one
 * transaction. The registry edits are independent of each other and written to
 * be re-runnable (upsert, or an idempotent UPDATE), so a failure part-way
 * leaves the remaining rows still pending — visible and re-clickable — rather
 * than rolling back work that already succeeded.
 */
export async function decideProposals(
  ids: readonly number[],
  decision: "apply" | "reject",
): Promise<DecisionResult> {
  const result: DecisionResult = { applied: [], rejected: [], skipped: [] };
  if (ids.length === 0) return result;

  const rows = await query<ProposalRow>(
    `SELECT id, run_id, created_at, slug, provider, task, action, reason, payload
       FROM model_proposals
      WHERE status = 'pending' AND id = ANY($1::bigint[])
      ORDER BY id ASC`,
    [ids],
    "modelProposals.decideProposals",
  );
  const proposals = rows.map(toProposal);

  let remainingGeneration = decision === "apply" ? await enabledGenerationCount() : 0;

  for (const proposal of proposals) {
    if (decision === "apply") {
      if (INFORMATIONAL_ACTIONS.has(proposal.action)) {
        result.skipped.push({
          id: proposal.id,
          reason: `${proposal.action} needs a manual decision — dismiss it once handled`,
        });
        continue;
      }
      if (removesGenerationModel(proposal) && remainingGeneration <= 1) {
        result.skipped.push({
          id: proposal.id,
          reason: "would leave no enabled generation models",
        });
        continue;
      }
      await applyOne(proposal);
      if (removesGenerationModel(proposal)) remainingGeneration -= 1;
      if (proposal.action === "add_trial" && proposal.task === "generation") {
        remainingGeneration += 1;
      }
    }

    await query(
      `UPDATE model_proposals SET status = $2, decided_at = now() WHERE id = $1`,
      [proposal.id, decision === "apply" ? "applied" : "rejected"],
      "modelProposals.markDecided",
    );
    (decision === "apply" ? result.applied : result.rejected).push(proposal.id);
  }

  // The pool is the library's voice; a change to it deserves the same durable
  // record as a failure does. Vercel Hobby keeps no log history, so this event
  // (and its Telegram push) is the only lasting trace of who changed what.
  if (result.applied.length > 0 || result.rejected.length > 0) {
    await monitor("model_pool_decided", {
      decision,
      applied: result.applied.length,
      rejected: result.rejected.length,
      skipped: result.skipped.length,
      slugs: proposals.map((p) => p.slug),
    });
  }

  return result;
}
