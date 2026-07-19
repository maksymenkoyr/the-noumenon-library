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
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at   TIMESTAMPTZ              -- when status moved to ok/taken_down
);

-- Dedup lookup; content_hash is deliberately NOT unique (near-duplicates
-- are allowed), we only check exact collisions before commit.
CREATE INDEX IF NOT EXISTS pages_content_hash_idx ON pages (content_hash);

-- Books experiment (docs/books.md): volume = book. One row per volume, created
-- lazily when the volume's first page generates under BOOK_MODE. Keyed by the
-- address prefix "gallery/wall/shelf/volume" — a prefix, not a page address,
-- so no FK to pages is possible. Title/tags are filled from the first
-- committed page (post-commit call), staying NULL until that call succeeds.
CREATE TABLE IF NOT EXISTS books (
  volume_key     TEXT PRIMARY KEY,        -- e.g. 'io-9/3/2/17'
  title          TEXT,                    -- NULL until filled from the first committed page
  tags           TEXT[],                  -- 3–5 thematic tags; NULL until filled
  model          TEXT,                    -- provenance of the title/tags call
  prompt_variant TEXT,                    -- provenance of the title/tags call
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  titled_at      TIMESTAMPTZ              -- when title/tags were filled
);

-- Reverse-bell-curve condensation of a committed page (first/last sentences
-- near-verbatim, middle summarized) — computed once post-commit, read as
-- neighbor context under BOOK_MODE. NULL for pre-book-mode pages; filled
-- lazily on first neighbor read. Additive/idempotent.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS condensed TEXT;

-- Removed lever (form/register, docs/reference/generation.md): pages varied
-- via model rotation and temperature jitter alone from here on; books lost
-- their locked-per-volume register too. Idempotent drops for databases that
-- already had these columns.
ALTER TABLE pages DROP COLUMN IF EXISTS seed_word;
ALTER TABLE books DROP COLUMN IF EXISTS form;

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
  redeemed_ip TEXT                     -- best-effort, for the operator's record
);

-- Dev-mode grant: an invite flagged here redeems into a session that sees the
-- dev overlay (model + generation time; lib/devMode, app/[[...address]]). The
-- claim is baked into the signed cookie at redemption, so upgrading an already-
-- redeemed link takes effect only after it is re-clicked. Additive/idempotent.
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS dev_mode BOOLEAN NOT NULL DEFAULT false;

-- Reader signals (docs/architecture.md §8 "engagement", Phase 10). Two idioms,
-- both mirroring existing counter tables above:

-- Aggregate "like"/press count per page — one row per address, upserted +/-1 as
-- readers press or un-press a leaf (monthly_spend style). Per-reader state lives
-- in the browser (localStorage), so no user identifiers are stored here; this is
-- the public aggregate shown on the leaf and a success-bar research signal.
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

-- Seed the pool. ON CONFLICT DO NOTHING makes this idempotent and
-- override-friendly — an operator's manual UPDATE (e.g. flipping `enabled`
-- or `health` by hand) survives a re-run of this file.

-- Generation pool: temp 0.9 (the existing per-page jitter, config.ts, still
-- applies on top), max_tokens 1000, reasoning off. Weighted lottery
-- (lib/registry.ts chooseGenerationModel). Slugs verified against OpenRouter's
-- live GET /api/v1/models catalog (2026-07-12) except the two Google rows,
-- marked below.
INSERT INTO model_registry (slug, provider, task, enabled, weight, temperature, max_tokens, reasoning_enabled) VALUES
  ('deepseek/deepseek-v4-flash',     'openrouter', 'generation', true,  20, 0.9, 1000, false),
  ('moonshotai/kimi-k2.6',           'openrouter', 'generation', true,  20, 0.9, 1000, false),
  ('z-ai/glm-5.2',                   'openrouter', 'generation', true,  20, 0.9, 1000, false),
  ('anthropic/claude-haiku-4.5',     'openrouter', 'generation', true,  20, 0.9, 1000, false),
  ('mistralai/mistral-large-2512',   'openrouter', 'generation', true,  10, 0.9, 1000, false),
  -- Gemini 3 Flash: slug UNVERIFIED against Google's native /v1beta/openai/models
  -- catalog (no GOOGLE_API_KEY was available at seed time) — seeded disabled
  -- pending live resolution (docs/architecture.md §6, model-pool rework §1/§5).
  -- Flip `enabled` true once the slug is confirmed.
  ('gemini-3-flash',                 'google',     'generation', false, 10, 0.9, 1000, false),
  ('anthropic/claude-sonnet-5',      'openrouter', 'generation', false, 0,  0.9, 1000, false),
  ('anthropic/claude-opus-4.8',      'openrouter', 'generation', false, 0,  0.9, 1000, false)
ON CONFLICT (slug, task) DO NOTHING;

-- Moderation chain: temp 0, max_tokens 5, reasoning off, no variety by design
-- (docs/architecture.md §7 — an extra chain link is another chance to
-- wrongly FAIL benign-but-dark content). Walked in `order`
-- (lib/registry.ts moderationChain) until a clear PASS/FAIL.
INSERT INTO model_registry (slug, provider, task, enabled, "order", temperature, max_tokens, reasoning_enabled) VALUES
  -- Gemini 3.1 Flash-Lite: same UNVERIFIED-slug caveat as the generation row
  -- above; also seeded disabled pending live resolution. Until then,
  -- moderation runs Haiku-only (order 2 promotes to the sole active model).
  ('gemini-3.1-flash-lite',      'google',     'moderation', false, 1, 0, 5, false),
  ('anthropic/claude-haiku-4.5', 'openrouter', 'moderation', true,  2, 0, 5, false)
ON CONFLICT (slug, task) DO NOTHING;
