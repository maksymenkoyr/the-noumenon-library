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
