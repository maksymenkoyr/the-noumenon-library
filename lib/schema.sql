-- The canonical library. See docs/architecture.md §8.
-- Idempotent: safe to re-run against an existing database.

CREATE TABLE IF NOT EXISTS pages (
  address        TEXT PRIMARY KEY,        -- normalized canonical string (§5)
  status         TEXT NOT NULL            -- 'generating' | 'ok' | 'taken_down'
                 DEFAULT 'generating',
  content        TEXT,                    -- NULL while generating / for placeholders
  content_hash   TEXT,                    -- SHA-256 of content; NULL until committed
  model          TEXT,                    -- e.g. 'nvidia/nemotron-3-super-120b-a12b:free'
  prompt_variant TEXT,                    -- slug of the prompt template/version used
  temperature    REAL,                    -- entropy lever, provenance
  seed_word      TEXT,                    -- deprecated/unused (book-mode form/axis
                                           -- fingerprint, since removed); retained nullable
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at   TIMESTAMPTZ              -- when status moved to ok/taken_down
);

-- Dedup lookup; content_hash is deliberately NOT unique (near-duplicates
-- are allowed), we only check exact collisions before commit.
CREATE INDEX IF NOT EXISTS pages_content_hash_idx ON pages (content_hash);

-- Deprecated/unused: the books experiment (volume = book, BOOK_MODE) was
-- removed from the app. Table left in place (non-destructive) rather than
-- migrated away; safe to drop in a future migration.
CREATE TABLE IF NOT EXISTS books (
  volume_key     TEXT PRIMARY KEY,        -- e.g. 'io-9/3/2/17'
  form           TEXT NOT NULL,           -- locked register for every page in the book
  title          TEXT,                    -- NULL until filled from the first committed page
  tags           TEXT[],                  -- 3–5 thematic tags; NULL until filled
  model          TEXT,                    -- provenance of the title/tags call
  prompt_variant TEXT,                    -- provenance of the title/tags call
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  titled_at      TIMESTAMPTZ              -- when title/tags were filled
);

-- Deprecated/unused: condensation was part of the removed books experiment
-- (BOOK_MODE neighbor context). Column left in place (non-destructive).
ALTER TABLE pages ADD COLUMN IF NOT EXISTS condensed TEXT;

-- Unified generation-inputs record (lib/store.ts PageInputs): everything that
-- produced the page — full prompt, levers, moderation model, timings — as one
-- JSONB object. The scalar provenance columns above remain the SQL-queryable
-- projection (the insight views read them), written from this same object at
-- commit (lib/store.ts commitPage). NULL for rows committed before this
-- column existed — readers degrade to the scalar columns. Additive/idempotent.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS inputs JSONB;

-- Economics & safety controls (docs/architecture.md §10, Phase 6). The counter
-- store is Postgres (not edge KV): the DB is already provisioned and "fine at
-- this scale" (§10), so no new infra is introduced.

-- Per-visitor generation rate limit: one append-only row per admitted
-- generation, keyed by a *hashed* IP (never the raw address — §12/legal.md).
-- A sliding-window count over created_at enforces the limit; rows outside the
-- window are pruned opportunistically, so nothing is retained long-term.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id         BIGSERIAL PRIMARY KEY,
  ip_hash    TEXT NOT NULL,           -- sha256(salt + ip); not reversible to the IP
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_ip_time_idx
  ON rate_limit_hits (ip_hash, created_at);

-- Monthly spend counter: one row per calendar month (UTC), incremented per
-- generation by token count and tokens×price. Checked before each generation;
-- over the cap flips the library to explore-only (§10). Free (`:free`) models
-- price at 0, so the counter tracks tokens while cost stays 0 until a paid tier.
CREATE TABLE IF NOT EXISTS monthly_spend (
  month    TEXT PRIMARY KEY,          -- 'YYYY-MM' (UTC)
  tokens   BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC NOT NULL DEFAULT 0
);

-- Private-access invite tokens (reusable links). Each row is a unique,
-- unguessable token issued to one person (scripts/invite.mjs). Redeeming it
-- (app/api/access) drops a signed session cookie in that browser and stamps
-- redeemed_at/redeemed_ip with the most recent use; the link stays valid on any
-- device, any number of times. The token is the PRIMARY KEY, so duplicates are
-- impossible by construction. Not part of the public library — the gate
-- (proxy.ts) is inert unless ACCESS_SIGNING_SECRET is set. See the private-share
-- deploy notes.
CREATE TABLE IF NOT EXISTS access_tokens (
  token       TEXT PRIMARY KEY,        -- 128-bit random; PK => no duplicates
  label       TEXT,                    -- who it was issued to (operator note)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at TIMESTAMPTZ,             -- most recent successful redemption
  redeemed_ip TEXT                     -- salted hash (lib/ipHash), never the raw IP; best-effort, for the operator's record
);

-- Dev-mode grant: an invite flagged here redeems into a session that sees the
-- dev overlay (model + generation time; lib/devMode, app/[[...address]]). The
-- claim is baked into the signed cookie at redemption, so upgrading an already-
-- redeemed link takes effect only after it is re-clicked. Additive/idempotent.
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS dev_mode BOOLEAN NOT NULL DEFAULT false;

-- One-time privacy cleanup: redeemed_ip used to store the raw address; it is
-- now written as a salted sha256 hex digest (lib/ipHash, app/api/access).
-- Clear any legacy value that isn't a 64-char hex hash. Idempotent: hashed
-- values never match the filter.
UPDATE access_tokens SET redeemed_ip = NULL
 WHERE redeemed_ip IS NOT NULL AND redeemed_ip !~ '^[0-9a-f]{64}$';

-- Redemption history: one row per invite per distinct place it was redeemed
-- from (app/api/access upserts on each click). Place-level, not per-visit —
-- repeat clicks from the same place bump `uses` rather than adding rows, so
-- the table stays bounded and no visit timeline is recorded. Privacy posture
-- unchanged from redeemed_ip above: salted hashes only (lib/ipHash), never
-- the raw IP.
CREATE TABLE IF NOT EXISTS invite_redemptions (
  token      TEXT NOT NULL REFERENCES access_tokens(token),
  ip_hash    TEXT NOT NULL,             -- salted hash (lib/ipHash), never the raw IP
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  uses       BIGINT NOT NULL DEFAULT 1, -- clicks from this place, not visits
  PRIMARY KEY (token, ip_hash)
);

-- Reader signals (docs/architecture.md §8 "engagement", Phase 10). Two idioms,
-- both mirroring existing counter tables above:

-- Aggregate like count per page — one row per address, upserted +/-1 as
-- readers like or unlike a page (monthly_spend style). Per-reader state lives
-- in the browser (localStorage), so no user identifiers are stored here; this is
-- the public aggregate shown on the page and a success-bar research signal.
CREATE TABLE IF NOT EXISTS page_likes (
  address TEXT PRIMARY KEY REFERENCES pages(address),
  count   BIGINT NOT NULL DEFAULT 0    -- clamped >= 0 by the writer (lib/engagement.ts)
);

-- Dwell-time signal — the reserved append-only research table (§8). Kept
-- separate from `pages` so that precious table stays small and write-light.
-- No user identifiers: aggregate behavioral signal, cross-referenceable with
-- generation provenance, not per-person tracking (docs/legal.md).
CREATE TABLE IF NOT EXISTS engagement (
  id          BIGSERIAL PRIMARY KEY,
  address     TEXT NOT NULL REFERENCES pages(address),
  dwell_ms    INTEGER,                 -- time on page
  arrived_via TEXT,                    -- 'random' | 'next' | 'typed' (best-effort, may be NULL)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS engagement_address_time_idx
  ON engagement (address, created_at);

-- Raw reader-timeline events (§8) — the source of truth behind `engagement`.
-- One row per client-emitted event (arrive/visible/hidden/idle/active/leave),
-- keyed by an EPHEMERAL per-page-load id (crypto.randomUUID(), minted in
-- memory on mount, never persisted client-side, cannot correlate across pages
-- or visits — not a cookie, not a session token). `t_ms` is relative to
-- performance.now() at page load, not wall-clock. `device` is a coarse class
-- ('mobile'|'tablet'|'desktop') derived server-side from the User-Agent header
-- (lib/device.ts) — the raw UA string is never stored. No user identifiers
-- (docs/reference/legal.md).
CREATE TABLE IF NOT EXISTS page_events (
  load_id     UUID NOT NULL,
  seq         SMALLINT NOT NULL,
  address     TEXT NOT NULL REFERENCES pages(address),
  event       TEXT NOT NULL
              CHECK (event IN ('arrive','visible','hidden','idle','active','leave')),
  t_ms        INTEGER NOT NULL,
  device      TEXT,
  arrived_via TEXT,                    -- only meaningful on the 'arrive' row
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (load_id, seq)           -- dedupe: a re-sent tail beacon is a no-op
);
CREATE INDEX IF NOT EXISTS page_events_address_time_idx
  ON page_events (address, created_at);

-- `engagement` becomes a per-load summary row (idle-corrected dwell,
-- recomputed from page_events), not one row per beacon flush — the unique
-- index makes repeated flushes for the same load an upsert, not new rows.
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS load_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS engagement_load_id_key
  ON engagement (load_id) WHERE load_id IS NOT NULL;

-- Silent negative signal — the "not for me" mark. Same aggregate-counter idiom
-- as page_likes (per-reader state in localStorage, no identifiers), but the
-- count is NEVER shown to readers: it exists only for the operator's insight
-- views.
CREATE TABLE IF NOT EXISTS page_dislikes (
  address TEXT PRIMARY KEY REFERENCES pages(address),
  count   BIGINT NOT NULL DEFAULT 0    -- clamped >= 0 by the writer (lib/engagement.ts)
);

-- Reader content reports — a moderation signal, distinct from the dislike
-- taste signal. Append-only queue reviewed by the operator (/operator + the
-- insight views); resolving a report does NOT take the page down
-- (scripts/takedown.mjs remains the removal tool). NO user identifiers on the
-- row (docs/legal.md) — abuse is bounded upstream by the hashed-IP engagement
-- throttle, which never joins to this table.
CREATE TABLE IF NOT EXISTS page_reports (
  id          BIGSERIAL PRIMARY KEY,
  address     TEXT NOT NULL REFERENCES pages(address),
  reason      TEXT,                     -- optional, writer-truncated (lib/reports.ts)
  status      TEXT NOT NULL             -- 'open' | 'resolved'
              DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS page_reports_status_time_idx
  ON page_reports (status, created_at);

-- Anti-gaming throttle for the reader-signal write endpoints (like / dwell),
-- kept separate from rate_limit_hits so generation and engagement limits don't
-- contaminate each other. Same append-only, hashed-IP, prune-outside-the-window
-- pattern as rate_limit_hits; nothing retained long-term.
CREATE TABLE IF NOT EXISTS engagement_rate_limit_hits (
  id         BIGSERIAL PRIMARY KEY,
  ip_hash    TEXT NOT NULL,           -- sha256(salt + ip); not reversible to the IP
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS engagement_rate_limit_hits_ip_time_idx
  ON engagement_rate_limit_hits (ip_hash, created_at);

-- Operator grant: an invite flagged here redeems into a session that can see
-- /operator (lib/operatorMode.ts) — same claim mechanism as dev_mode above,
-- baked into the signed cookie at redemption (re-click to pick up an upgrade).
-- Additive/idempotent.
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS operator BOOLEAN NOT NULL DEFAULT false;

-- Insight views (docs/architecture.md §8, Phase 10 "Both": SQL views as the
-- source of truth, read by lib/insights.ts and rendered on /operator).
-- Gotcha: CREATE OR REPLACE VIEW cannot drop or reorder existing columns,
-- only append new ones at the end — a future shape change needs DROP VIEW
-- first. "visits" always means dwell-beacon rows (>=1s visible dwell; see
-- marks.tsx's "ignore sub-second glances") — the only visit proxy the
-- no-identifiers privacy posture (docs/legal.md) allows; there is no raw
-- page-view counter. Views must appear after all table DDL; page_signals
-- must appear before the rollup views that select from it.

-- Per-page rollup: provenance + every reader signal, one row per committed
-- ('ok') page.
CREATE OR REPLACE VIEW page_signals AS
SELECT
  p.address,
  p.model,
  p.prompt_variant,
  p.temperature,
  p.created_at,
  COALESCE(l.count, 0)      AS likes,
  COALESCE(d.count, 0)      AS dislikes,
  COALESCE(r.open_reports, 0) AS open_reports,
  COALESCE(e.visits, 0)     AS visits,
  e.avg_dwell_ms,
  e.median_dwell_ms
FROM pages p
LEFT JOIN page_likes l ON l.address = p.address
LEFT JOIN page_dislikes d ON d.address = p.address
LEFT JOIN (
  SELECT address, count(*) FILTER (WHERE status = 'open') AS open_reports
  FROM page_reports
  GROUP BY address
) r ON r.address = p.address
LEFT JOIN (
  SELECT
    address,
    count(*) AS visits,
    avg(dwell_ms) AS avg_dwell_ms,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell_ms))::int AS median_dwell_ms
  FROM engagement
  GROUP BY address
) e ON e.address = p.address
WHERE p.status = 'ok';

-- Per-model rollup over page_signals.
CREATE OR REPLACE VIEW model_signals AS
SELECT
  model,
  count(*)               AS pages,
  sum(likes)              AS likes,
  sum(dislikes)           AS dislikes,
  sum(open_reports)       AS open_reports,
  sum(visits)             AS visits,
  avg(median_dwell_ms)    AS avg_median_dwell_ms
FROM page_signals
GROUP BY model;

-- Per-prompt-variant rollup over page_signals.
CREATE OR REPLACE VIEW variant_signals AS
SELECT
  prompt_variant,
  count(*)               AS pages,
  sum(likes)              AS likes,
  sum(dislikes)           AS dislikes,
  sum(open_reports)       AS open_reports,
  sum(visits)             AS visits,
  avg(median_dwell_ms)    AS avg_median_dwell_ms
FROM page_signals
GROUP BY prompt_variant;

-- Per-arrival-route rollup, directly over engagement (not page_signals — every
-- dwell beacon counts here, including ones on a page later taken down).
CREATE OR REPLACE VIEW arrival_signals AS
SELECT
  arrived_via,
  count(*)                                                              AS visits,
  avg(dwell_ms)                                                         AS avg_dwell_ms,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell_ms))::int     AS median_dwell_ms
FROM engagement
GROUP BY arrived_via;

-- Per-model performance telemetry (lib/modelStats.ts, docs/architecture.md §6/§10).
-- Narrowed role vs. the original prototype: pure latency telemetry (avgMs, used as
-- a bounded tiebreak within model_registry's configured weights, lib/registry.ts)
-- plus the account-wide OpenRouter `free-models-per-day` cooldown, kept on its own
-- sentinel row ('__free_tier__', lib/modelStats.ts FREE_TIER_KEY) since that 429
-- flavor caps every :free model at once. Per-model health/cooldown now lives on
-- model_registry (cooling/unavailable, §7 below) — rate_limited_until here is only
-- ever set for the free-tier sentinel. Recording is fire-and-forget: a stats-table
-- hiccup must never break or slow a real generation/moderation call.
CREATE TABLE IF NOT EXISTS model_stats (
  model              TEXT PRIMARY KEY,          -- model id, or the '__free_tier__' sentinel
  calls              BIGINT NOT NULL DEFAULT 0, -- successful sampled completions
  total_ms           BIGINT NOT NULL DEFAULT 0, -- Σ duration; avg = total_ms / calls
  errors             BIGINT NOT NULL DEFAULT 0, -- failed attempts (any error)
  rate_limited_until TIMESTAMPTZ,               -- skip this model while now() < this
  last_used_at       TIMESTAMPTZ
);

-- Model pool registry (docs/architecture.md §6/§7, model-pool rework). Each
-- row is one model's config for ONE task — the composite PK is the whole
-- point, since the same model needs opposite settings depending on the job
-- (Claude Haiku 4.5 holds both a generation row — temp 0.9, weighted lottery,
-- variety is the point — and a moderation row — temp 0, fixed chain position,
-- no variety at all). lib/registry.ts is the only reader/writer; selection
-- (poolFor) filters to enabled rows whose provider key is configured
-- (lib/providers.ts) and whose health allows it.
CREATE TABLE IF NOT EXISTS model_registry (
  slug              TEXT NOT NULL,               -- provider's model id
  provider          TEXT NOT NULL,               -- 'openrouter' | 'google'
  task              TEXT NOT NULL,               -- 'generation' | 'moderation'
  enabled           BOOLEAN NOT NULL DEFAULT true,
  weight            INTEGER NOT NULL DEFAULT 0,  -- generation only: weighted-lottery share
  "order"           INTEGER NOT NULL DEFAULT 0,  -- moderation only: chain position
  temperature       REAL NOT NULL DEFAULT 0,
  max_tokens        INTEGER NOT NULL DEFAULT 1000,
  reasoning_enabled BOOLEAN NOT NULL DEFAULT false,
  health            TEXT NOT NULL DEFAULT 'ok',  -- 'ok' | 'cooling' | 'unavailable'
  cooling_until     TIMESTAMPTZ,                 -- 'cooling' only: skip while now() < this
  PRIMARY KEY (slug, task)
);

-- Pricing and lifecycle, owned by the daily review job (lib/modelReview.ts,
-- scripts/review-models.mjs). Additive/idempotent.
--
-- Price lives here rather than in the hand-maintained MODEL_PRICES env map
-- (lib/config.ts) because the map cannot know it has gone stale, and the
-- monthly spend cap (lib/economics.ts) is metered from it — a repriced model
-- silently under-reports its own cost against the one rail that stops runaway
-- spend. The job syncs `price_per_million` from each provider's live catalog;
-- config's map stays supported as an explicit override for anything the
-- catalog gets wrong or doesn't list.
--
-- `baseline_price` is the comparison point for the spike guard, not a
-- historical low: it is stamped when a row is enabled, so "this model got 3x
-- more expensive than when we chose it" is answerable without a price history
-- table. NULL means never stamped — the guard skips the row rather than
-- treating NULL as 0 and disabling everything.
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS price_per_million NUMERIC;
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS price_checked_at  TIMESTAMPTZ;
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS baseline_price    NUMERIC;

-- Time-boxed membership. `expires_at` NULL = permanent (every hand-seeded row);
-- otherwise selection stops at that instant (lib/registry.ts poolFor) and the
-- daily job disables the row. Two uses: a promotional/discount window worth
-- riding only while it lasts, and `trial` rows — models the review job proposed
-- from OpenRouter's usage rankings, which get a small weight and a fixed window
-- to earn a place. A trial that nobody promotes expires on its own, so an
-- unattended digest can never permanently widen the pool.
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS trial BOOLEAN NOT NULL DEFAULT false;

-- Seed the pool. ON CONFLICT DO NOTHING makes this idempotent and
-- override-friendly — an operator's manual UPDATE (e.g. flipping `enabled`
-- or `health` by hand) survives a re-run of this file.

-- Generation pool: temp 0.9 (the existing per-page jitter, config.ts, still
-- applies on top), max_tokens 1000, reasoning off. Weighted lottery
-- (lib/registry.ts chooseGenerationModel). Slugs verified against OpenRouter's
-- live GET /api/v1/models catalog (2026-07-12) and Google's native
-- /v1beta/openai/models catalog (2026-08-02).
INSERT INTO model_registry (slug, provider, task, enabled, weight, temperature, max_tokens, reasoning_enabled) VALUES
  ('deepseek/deepseek-v4-flash',     'openrouter', 'generation', true,  20, 0.9, 1000, false),
  ('moonshotai/kimi-k2.6',           'openrouter', 'generation', true,  20, 0.9, 1000, false),
  ('z-ai/glm-5.2',                   'openrouter', 'generation', true,  20, 0.9, 1000, false),
  ('anthropic/claude-haiku-4.5',     'openrouter', 'generation', true,  20, 0.9, 1000, false),
  ('mistralai/mistral-large-2512',   'openrouter', 'generation', true,  10, 0.9, 1000, false),
  -- Gemini 3 Flash Preview: resolved live (2026-08-02). The originally seeded
  -- `gemini-3-flash` does not exist — Google returns 404 NOT_FOUND for it — and
  -- is dropped by the fix-ups below. `-preview` is the real slug, and it was
  -- verified to accept the exact `reasoning_effort: "none"` that
  -- lib/providers.ts reasoningParams() sends unconditionally (several newer
  -- Gemini slugs 400 on that value and are therefore unusable here).
  ('gemini-3-flash-preview',         'google',     'generation', true,  10, 0.9, 1000, false),
  ('anthropic/claude-sonnet-5',      'openrouter', 'generation', false, 0,  0.9, 1000, false),
  -- Escape hatches, off by default: only reachable by a deliberate operator
  -- UPDATE. claude-opus-5 supersedes the originally seeded claude-opus-4.8 at
  -- identical pricing ($5/$25); the 4.8 row is dropped by the fix-ups below.
  ('anthropic/claude-opus-5',        'openrouter', 'generation', false, 0,  0.9, 1000, false)
ON CONFLICT (slug, task) DO NOTHING;

-- Moderation chain: temp 0, max_tokens 5, reasoning off. Walked in `order`
-- (lib/registry.ts moderationChain) until a clear PASS/FAIL.
--
-- docs/architecture.md §7's "no variety by design" caution (an extra link is
-- another chance to wrongly FAIL benign-but-dark content) applies to an
-- any-fail chain. This chain is serial-first-verdict (lib/moderate.ts): a
-- later link only runs when every earlier one abstains or errors, so it adds
-- no false-FAIL risk on the normal path — it only supplies a verdict where the
-- chain would otherwise throw and leave the address dark. Public-launch
-- redundancy: Haiku-only was a single point of failure (one outage darkens
-- every first-visit); orders 3-4 are a paid fallback pair so the chain
-- degrades to explore-only rather than throwing. Cost is negligible at
-- max_tokens=5.
INSERT INTO model_registry (slug, provider, task, enabled, "order", temperature, max_tokens, reasoning_enabled) VALUES
  -- Gemini 3.1 Flash-Lite: slug resolved live (2026-08-02) and verified to
  -- accept `reasoning_effort: "none"`. At `order` 1 it fields every first-visit
  -- verdict ahead of Haiku — deliberate: it is free-tier on Google's native
  -- API, so the common path costs nothing and the paid links below become the
  -- fallback they were always meant to be.
  ('gemini-3.1-flash-lite',        'google',     'moderation', true,  1, 0, 5, false),
  ('anthropic/claude-haiku-4.5',   'openrouter', 'moderation', true,  2, 0, 5, false),
  ('mistralai/mistral-large-2512', 'openrouter', 'moderation', true,  3, 0, 5, false),
  ('deepseek/deepseek-v4-flash',   'openrouter', 'moderation', true,  4, 0, 5, false)
ON CONFLICT (slug, task) DO NOTHING;

-- Pool fix-ups (2026-08-02). The seeds above are ON CONFLICT DO NOTHING, which
-- is what lets an operator's hand-edit survive a re-run — and equally what
-- makes editing a seed's VALUES a silent no-op on any database that already
-- has the row. Anything that must change on an EXISTING database has to be
-- stated as its own idempotent statement, here. Same posture as the
-- redeemed_ip backfill further up this file.
--
-- Dead slug: Google 404s on `gemini-3-flash` (verified live). It was seeded
-- disabled in production, so this drops a row that never ran; on any database
-- where it was enabled by hand, this is the fix.
DELETE FROM model_registry WHERE slug = 'gemini-3-flash';
-- Superseded by claude-opus-5 above at identical pricing. Safe to drop
-- outright: the row was seeded disabled at weight 0, so nothing selected it.
DELETE FROM model_registry WHERE slug = 'anthropic/claude-opus-4.8';
-- Both Google rows were seeded disabled pending slug verification. They are
-- verified now, so turn them on where they are still sitting at the seeded
-- default. Scoped to health <> 'unavailable' so this never resurrects a row
-- that lib/registry.ts markUnavailable() has since retired.
UPDATE model_registry SET enabled = true
 WHERE slug IN ('gemini-3-flash-preview', 'gemini-3.1-flash-lite')
   AND provider = 'google'
   AND enabled = false
   AND health <> 'unavailable';

-- Seed prices, so the spend cap meters correctly and the spike guard has a
-- baseline from the first run rather than the first *successful* catalog fetch.
-- Blended $/M output tokens, read off the live catalogs 2026-08-02. Google's
-- rows are free-tier and intentionally absent → they stay NULL and price at 0,
-- same convention as MODEL_PRICES.
--
-- Idempotent by `IS NULL`, and that guard is load-bearing in both directions:
-- re-running never clobbers a price the daily job has since synced, and never
-- resets a baseline to a stale figure — which would silently re-arm the spike
-- guard against the wrong reference and disable a model we already accepted.
UPDATE model_registry AS m SET
  price_per_million = COALESCE(m.price_per_million, seed.price),
  baseline_price    = COALESCE(m.baseline_price, seed.price)
FROM (VALUES
  ('deepseek/deepseek-v4-flash',   0.28),
  ('moonshotai/kimi-k2.6',         2.48),
  ('z-ai/glm-5.2',                 3.52),
  ('anthropic/claude-haiku-4.5',   5.00),
  ('mistralai/mistral-large-2512', 1.50),
  ('anthropic/claude-sonnet-5',   10.00),
  ('anthropic/claude-opus-5',     25.00)
) AS seed(slug, price)
WHERE m.slug = seed.slug
  AND (m.price_per_million IS NULL OR m.baseline_price IS NULL);

-- Proposals raised by the daily review job and awaiting an operator decision
-- (app/operator, app/api/operator/apply-models). One row per proposed change
-- per run: the Telegram digest and the dashboard render the same records, so
-- what the message described is exactly what the Apply button applies.
--
-- `action` is the verb the apply route dispatches on; `payload` carries its
-- arguments (target weight, expires_at, replacement slug…) so a new proposal
-- kind needs no migration. `status` starts 'pending' and is terminal
-- thereafter — applied/rejected/superseded rows are kept as the audit trail of
-- what the pool was asked to become and what a human actually said to it.
CREATE TABLE IF NOT EXISTS model_proposals (
  id          BIGSERIAL PRIMARY KEY,
  run_id      UUID NOT NULL,               -- groups one job run's proposals
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  slug        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  task        TEXT NOT NULL,
  action      TEXT NOT NULL,               -- 'add_trial'|'promote'|'drop'|'swap'|'reprice'|'enable'|'disable'
  reason      TEXT NOT NULL,               -- human-readable, shown verbatim in the digest
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'applied'|'rejected'|'superseded'
  decided_at  TIMESTAMPTZ
);

-- The dashboard's only hot query is "pending proposals, newest run first".
CREATE INDEX IF NOT EXISTS model_proposals_pending_idx
  ON model_proposals (created_at DESC) WHERE status = 'pending';
