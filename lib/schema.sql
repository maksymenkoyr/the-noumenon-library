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
  seed_word      TEXT,                    -- removed lever; retained nullable, left null
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at   TIMESTAMPTZ              -- when status moved to ok/taken_down
);

-- Dedup lookup; content_hash is deliberately NOT unique (near-duplicates
-- are allowed), we only check exact collisions before commit.
CREATE INDEX IF NOT EXISTS pages_content_hash_idx ON pages (content_hash);

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

-- Per-model performance telemetry (lib/modelStats.ts, docs/architecture.md §6/§10).
-- Fed by both the generation and moderation pipelines so free-vs-paid selection is
-- data-driven: average latency (total_ms / calls) down-weights slow free models, and
-- rate_limited_until parks a model that just errored so it's skipped until the cooldown
-- expires. One sentinel row keyed '__free_tier__' (lib/modelStats.ts FREE_TIER_KEY) holds
-- the account-wide OpenRouter `free-models-per-day` cooldown — that 429 flavor caps every
-- :free model at once, so generation short-circuits straight to the paid tail instead of
-- cycling the whole free pool. Recording is fire-and-forget: a stats-table hiccup must
-- never break or slow a real generation/moderation call.
CREATE TABLE IF NOT EXISTS model_stats (
  model              TEXT PRIMARY KEY,          -- model id, or the '__free_tier__' sentinel
  calls              BIGINT NOT NULL DEFAULT 0, -- successful sampled completions
  total_ms           BIGINT NOT NULL DEFAULT 0, -- Σ duration; avg = total_ms / calls
  errors             BIGINT NOT NULL DEFAULT 0, -- failed attempts (any error)
  rate_limited_until TIMESTAMPTZ,               -- skip this model while now() < this
  last_used_at       TIMESTAMPTZ
);
