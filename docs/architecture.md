---
title: Architecture
---

# Architecture

The system is small on the surface — a Next.js app with a couple of routes — but the interesting parts are the invariants it must hold: **same address → same page forever**, **never charge twice for one page**, **never store unmoderated content**, and **never lose the store**. This document is organized around those invariants.

> **Status legend** — 🟢 implemented · 🟡 decided, not built · ⚪ open (see [Roadmap](./roadmap.md))

---

## 1. Component overview

```
                         Browser
                            │  (navigates to an address)
                            ▼
        ┌──────────────────────────────────────────────┐
        │  Next.js (App Router) — Vercel serverless     │
        │                                                │
        │  app/[[...address]]/page.tsx   ← thin display  │
        │        │ calls shared lib directly (no HTTP)   │
        │        ▼                                       │
        │  lib/library.ts  ← the page-resolution logic   │
        │        │                                       │
        │   ┌────┴─────────────────────────────────┐    │
        │   │ 1 normalize address                   │    │
        │   │ 2 store lookup ──── hit ─────────────►│ return
        │   │ 3 miss: reserve address (idempotency) │    │
        │   │ 4 check spend cap + rate limit        │    │
        │   │ 5 generate (LLM, address-anchored)    │    │
        │   │ 6 moderate                            │    │
        │   │ 7 dedup (content_hash)                │    │
        │   │ 8 commit to store                     │    │
        │   └───────────────────────────────────────┘    │
        └───────┬───────────────┬───────────────┬───────┘
                ▼               ▼               ▼
         Page Store        LLM Provider     Moderation
        (Neon Postgres)    (OpenRouter)     (cheap LLM call)
```

Two HTTP entry points are planned:

| Route | Method | Purpose | Status |
|---|---|---|---|
| `app/[[...address]]/page.tsx` | — | Renders a page for an address (server component) | 🟢 |
| `app/api/reader/route.ts` | `POST` | AI-reader layer: interpret page, surface resonance, suggest next | ⚪ |
| `app/api/generate/route.ts` | `GET` | Current prototype generator (no address, no store) | 🟢 (to be replaced) |

**All business logic lives in `lib/`, not in components or route handlers.** The route handler and the server component are both thin adapters that call the same `resolvePage(address)` function. This is what makes the "extract to a standalone service" scaling path cheap — see [§13](#13-scaling-path).

> **Why a shared lib instead of the page calling `/api/generate` over HTTP?** The current [`app/page.tsx`](../app/page.tsx) does `fetch("http://localhost:3000/api/generate")`. That hardcodes localhost (breaks on Vercel), pays a network round-trip to talk to itself, and forces request-time rendering. A server component should `await resolvePage(address)` directly. The API route stays only for non-React clients (the reader layer, future external callers).

---

## 2. The page-resolution lifecycle

This is the heart of the system — the function behind `resolvePage(address)`.

1. **Normalize** the raw address into its canonical form (see [§5](#5-address-format--normalization)). All later steps use the normalized string as the key.
2. **Store lookup** by primary key.
   - **Hit** → return immediately. No LLM call, no moderation, no rate-limit charge. This is the overwhelmingly common path once the library has grown, and it should be served with CDN cache headers ([§11](#11-runtime--deployment)) so most hits never even reach a function.
   - **Hit but `status = taken_down`** → return the takedown placeholder, not generated content.
   - **Miss** → continue.
3. **Reserve the address** to make generation idempotent under concurrency ([§3](#3-concurrency--idempotency)).
4. **Admission control** — check the monthly spend cap and the per-visitor rate limit ([§10](#10-economics-enforcement)). If the cap is hit, return **explore-only** (a friendly "this corner of the library is still dark" response); the address is *not* crystallized, so a future visit after reset can still generate it.
5. **Generate** — call the LLM with the active entropy levers ([§6](#6-generation-pipeline)). The address is *not* part of the prompt — it is only the key under which the result is stored.
6. **Moderate** the result ([§7](#7-moderation)).
7. **Dedup** — hash the content; if an identical page already exists at another address, regenerate once (a fresh sample) ([§8](#8-data-model)).
8. **Commit** — write `{content, content_hash, created_at, model, prompt_variant, temperature, status}` and release the reservation.

**Permanence is guaranteed by the store, not by algorithmic seeding.** There is no PRNG seed that reproduces a page; the only source of truth is the row in Postgres. This is why backups are a charter requirement ([§9](#9-permanence--backups)).

---

## 3. Concurrency & idempotency

🟢 **Implemented** (`lib/store.ts`, tested in `lib/store.test.ts` / `lib/resolvePage.test.ts`). **The problem:** "first visit crystallizes the page" + serverless = a race. If two people hit a never-seen address within the same second, two functions both see a store miss, both call the LLM, and you pay twice for one address (and may store two different pages, violating the canonical invariant).

**Resolution — reserve-then-generate using Postgres as the lock:**

1. On a store miss, attempt an insert of a *placeholder* row in `status = 'generating'`:
   ```sql
   INSERT INTO pages (address, status)
   VALUES ($1, 'generating')
   ON CONFLICT (address) DO NOTHING
   RETURNING address;
   ```
2. **If the insert returns a row**, this request won the race — it owns generation for this address.
3. **If it returns nothing**, another request is already generating. This request **polls/short-waits** for the row to flip to `ok` (or disappear, if the winner's generation failed and released the reservation; the next visitor then retries), then returns that result. No second LLM call.
4. The winner runs generate → moderate → dedup, then `UPDATE` the row to its final state.
5. **Stale reservation guard:** a `generating` row older than the stale window is considered abandoned and may be reclaimed, so a crashed generation never wedges an address permanently. The window is `STALE_RESERVATION_SECONDS` (default 300 s — it must exceed worst-case generation time, and the current `:free` reasoning model can take minutes; tighten alongside the model-tier revisit). A failed generation also proactively releases its reservation so the next visitor retries immediately.

This collapses N concurrent first-visitors into exactly one generation, which directly protects the spend cap ([§10](#10-economics-enforcement)).

---

## 4. Streaming & moderation interplay

You flagged generation latency and streaming — this is where they collide with the "never store unmoderated content" rule, so it deserves its own treatment.

**The tension:** streaming tokens to the browser as they arrive is the right cure for first-visit latency (the page *appears* to write itself, which also fits the artwork). But moderation can only judge a *complete* page, and we must not persist or share content that fails moderation.

**Resolution — stream live to the first visitor, gate persistence on completion:**

| Path | Behavior |
|---|---|
| **Cache hit** | Page already moderated and stored. Stream it (or send whole) from the store instantly. Zero risk. |
| **First visit (novel)** | Stream the LLM output live to the *single* first visitor while buffering the full text server-side. On stream completion: moderate the buffer → on pass, commit to store (now safe for everyone); on fail, regenerate once; if it still fails, discard and release the address to retry on a later visit (no dark-shelf — a recurring offender is surfaced via monitoring for a human to act on). |

**The accepted tradeoff:** the lone first visitor may briefly see content that later fails moderation, before it is discarded and never stored. Given moderation is scoped to *narrow illegal-content categories only* ([legal.md](./legal.md)) and the page is never shared or persisted, this is acceptable for the "first visit is an event" experience.

**If that tradeoff is ever unacceptable** (⚪ revisit), the fallback is *moderate-then-reveal*: buffer fully server-side, moderate, and only then stream from the buffer — trading the live-writing effect for zero exposure. The architecture supports both; it's a one-flag change in `resolvePage`.

> **Provider note:** OpenRouter exposes streaming via the OpenAI-compatible `stream: true`. The moderation call is a separate, non-streamed request on the completed buffer, so it adds latency only *after* the visible page has finished — it does not delay first paint.

---

## 5. Address format & normalization

🟢 **Decided and implemented (Phase 1): a human-scaled Borges coordinate.** Code: `lib/address.ts`, locked by `lib/address.test.ts`. The address mirrors the Library of Babel's spatial hierarchy, shrunk to typeable tokens. This makes `next`/`random` well-defined and reinforces the "vast but bounded horizon" theme — *without* inheriting Borges' fixed *content* length (that's a content decision, see [§6](#6-generation-pipeline)).

> **The address is the storage primary key and navigation coordinate only — it is *not* a generation input.** An earlier decision injected the address into the prompt as a "creative anchor"; that was reversed (the page narrated its own coordinate). Pages are *not* told where they are. A consequence: there is no content-level **locality** — neighboring addresses are not thematically related, and clustering them would require deliberately re-introducing the address as an input in a future phase ([generation.md](./generation.md)).

### Scheme

```
/{gallery}/{wall}/{shelf}/{volume}/{page}
       e.g.  /io-9/3/2/17/308
```

| Segment | Range | Source |
|---|---|---|
| `gallery` | lowercase `[a-z0-9-]`, 1–12 chars, hyphen never first or last | the vast dimension — astronomically large (~10¹⁸ galleries) but **enumerable** |
| `wall` | 1–4 | Borges |
| `shelf` | 1–5 | Borges |
| `volume` | 1–32 | Borges |
| `page` | 1–410 | Borges |

The four small dimensions come straight from Borges and give book structure plus short, typeable coordinates; the `gallery` token supplies the vastness and *is* the bounded-but-huge horizon. The whole space is **finite and enumerable** — deliberately, matching [concept.md](./concept.md)'s "honest about its horizon." **Wall × shelf are kept separate** (decided in Phase 1; not collapsed).

**Gallery enumeration order** (for `next` rollover): a mixed-radix counter — first/last positions draw from `0-9a-z` (36 symbols), interior positions from `-0-9a-z` (37, ASCII order, so lexicographic order equals enumeration order within a length). A carry past the leftmost character grows the token by one (`z` → `00`, `zz` → `0-0`); past the largest token (`zzzzzzzzzzzz`) the library **wraps to gallery `0`** — finite and closed, every address has a successor.

The **`page` is the atomic addressable unit** and a **fixed-size leaf** — a fixed container that holds a *bounded* amount of text (max, no min). See [§6](#6-generation-pipeline) for the generation constraint and [experience.md](./experience.md) for rendering.

### Navigation semantics

- **next** — increment `page` within the volume; roll over at 410 into the next volume, then shelf, wall, gallery. Adjacency is real and ordered.
- **random** — a random valid coordinate. Gallery *length* is chosen uniformly first, then characters — a deliberate deviation from strict uniformity (under which max-length galleries would dominate) so random landings stay typeable.
- **typed** — the visitor types a coordinate directly. (Mapping free-form *phrases* into gallery space is a parked hybrid enhancement — ⚪, [Roadmap](./roadmap.md).)

### Routing (Next.js 16)

- Optional catch-all segment: `app/[[...address]]/page.tsx`. The `[[...]]` form also matches `/` for the landing/random entry.
- `params` is a **Promise** in this Next version — `const { address } = await params` (in route handlers, `RouteContext<'/api/...'>`).
- `lib/normalizeAddress(segments)` runs before any store access — never trust the raw URL as a key.

### Normalization — permanent, test-locked

`normalizeAddress` is **effectively permanent**: changing it orphans every stored page. It is one pure function (`lib/address.ts`) locked by exhaustive tests (`lib/address.test.ts`, `npm test`). Rules as implemented:

- lower-case the `gallery` token — the **only** transformation; reject any character outside `[a-z0-9-]`, empty/oversized (>12) tokens, and leading/trailing hyphens
- `wall`/`shelf`/`volume`/`page` must be **canonical decimal** (`^[1-9][0-9]{0,2}$`) and in range — reject, don't clamp *or alias*: `03`, `+3`, `3.0` all 404 rather than silently mapping onto another URL's page
- canonical-join with `/` (`formatAddress`); the result is the primary key fed to both the store and the prompt anchor ([generation.md](./generation.md))

---

## 6. Generation pipeline

🟢 **Implemented** (Phase 3, extended Phase 4). Lever-driven, provenance-logged, deduped. Code: `lib/generate.ts` (levers + LLM call), `lib/prompts.ts` (variant registry, prompt owned by [generation.md](./generation.md)), `lib/pipeline.ts` (generate → moderate → dedup → result), `lib/moderate.ts` (real gate, §7). The prompt variant is **base-only** (`base-v1`) for now; the registry is built for more. The page is given no address and no seed word, so the prompt is identical for every page (see the lever table and [generation.md](./generation.md)). **Generation rotates across a free-model pool** (`GENERATION_MODELS`) — one picked at random per page and logged as `model`; under `DEV_MODE` the chosen model is console-logged.

**Provider:** **OpenRouter**, via the OpenAI-compatible SDK already in the repo. Decision and rationale:

- OpenRouter *is* the multi-model abstraction the entropy design wants — switching models is a config string, not a code change. This is the right substrate for the fine-tuning phase, where models/providers get experimented with per [generation.md](./generation.md)'s "different gravity wells" lever.
- **Current model:** `nvidia/nemotron-3-super-120b-a12b:free`.
- **Caveats to revisit (⚪):** (1) `:free` variants generally **train on inputs** — tolerable since pages are public machine-fiction, but worth a conscious choice; (2) free-tier **latency/availability** is the generation-time concern raised — moving to a cheap *paid* model is low-cost insurance under the ~$10/mo cap. Treat the model id as a tunable, not a constant.
- The API key (`OPENROUTER_API_KEY`) is **server-only** — it lives in `lib/`/route handlers, never shipped to the client ([§12](#12-security)).

**Entropy-lever injection points** (each lever is logged as provenance, [§8](#8-data-model)):

| Lever | Where it enters | Logged as |
|---|---|---|
| Model selection | `model` arg to the completion call | `model` |
| Temperature | `temperature` arg | `temperature` |
| Prompt variant | which base-prompt template/version was used | `prompt_variant` |

The prompt text itself is owned by [generation.md](./generation.md); this doc only specifies that generation is a pure function of `(model, temperature, prompt_variant)` plus model nondeterminism, and that all three are persisted so the library's own evolution stays mappable. **The address and a per-generation seed word were both removed as inputs** (the page is told neither where it is nor a seed word — see [generation.md](./generation.md)); the `seed_word` column is retained but left null. With no per-page input, the prompt is currently identical for every page and pages differ only by sampling.

**Page-size constraint (🟡 provisional).** The page is a fixed-size leaf: generation targets a **hard maximum** (calibrated to fill the leaf at the display font) and **no minimum**. The prompt states this explicitly (`PAGE_MAX_WORDS`, default 400). A separate `GENERATION_MAX_TOKENS` (default 4000) is only a **cost backstop**, kept generous on purpose — the `:free` nemotron is a reasoning model whose reasoning tokens count against the budget, so a tight cap would starve and visibly truncate the page. Partial pages are allowed and intentional ([experience.md](./experience.md)); the quality bar is **completeness, not fullness** — a page may end early but must never read as truncated or cut-off (the "coherent but hollow" failure mode in [generation.md](./generation.md)). To revisit after feel-testing.

---

## 7. Moderation

🟢 **Implemented (Phase 4).** `lib/moderate.ts` (gate) + `lib/pipeline.ts` (flow). **A secondary LLM yes/no call** (not a provider moderation endpoint) — extended to a **pool** of free models for resilience and A/B.

- **Scope:** narrow illegal-content categories only (e.g. CSAM, credible incitement). **No aesthetic filtering** — darkness and strangeness are features ([legal.md](./legal.md)). The classifier prompt explicitly allows horror/obscenity/the disturbing.
- **Mechanism:** a **pool** of free models (`MODERATION_MODELS`, entries `modelId@temp` mixing deterministic and non) run in **parallel**; each returns a one-token `PASS`/`FAIL` (abstaining if its reply is unclear or it errors). Verdicts combine via `MODERATION_POLICY` ∈ `any-fail` (default, safety-first) | `majority` | `unanimous-fail`. Provider-agnostic; no OpenAI dependency.
- **Undetermined → retry, never store:** if *every* pool model abstains, `moderate()` throws; `resolvePage` releases the reservation and the address is retried on a later visit — so a transient free-tier outage never stores unmoderated content.
- **When it runs:** on **novel pages only**, after generation completes — never on cache hits.
- **On fail:** regenerate **once** (a fresh sample). If the regeneration also fails, the pipeline emits a `moderation_persistent_reject` monitoring event ([`lib/monitor.ts`](../lib/monitor.ts)) and throws — `resolvePage` releases the reservation and the address is retried on a later visit. **There is no permanent dark-shelf:** we don't believe any address consistently yields illegal content, so rather than auto-blocking we surface the rare 2-reject case for a human to investigate and, if warranted, take down. (A dedup regeneration is also re-moderated before it can replace already-passed content.)
- **Latency posture:** one parallel pool call per *new* page; zero on the hot (cache-hit) path. Verdicts are logged (console, verbose under `DEV_MODE`) for A/B comparison, not persisted.

> **Fallback option (⚪):** if the yes/no LLM proves unreliable or slow, a hosted moderation endpoint can be swapped in behind the same `moderate(text)` interface. The OpenAI moderation API is the obvious candidate but is deprioritized per your preference.

So the moderation flow is: **regenerate-once on first fail; on a second fail, flag (monitor) and release for retry — never store, never permanently block.** Reactive takedown writes `taken_down` directly ([§8](#8-data-model), [legal.md](./legal.md)).

---

## 8. Data model

**Store:** **Postgres via Neon.** Relational fits the three jobs a key→value store does poorly: dedup-by-hash, provenance queries, and dwell-time analytics.

🟢 Schema implemented in `lib/schema.sql`, applied idempotently via `npm run db:migrate`; store operations in `lib/store.ts`. Dev runs against local Postgres; production awaits Neon provisioning (`DATABASE_URL` is the only coupling).

### `pages` — the canonical library

```sql
CREATE TABLE pages (
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

-- Dedup needs this; content_hash is NOT unique by table design
-- (near-duplicates are allowed) but we look up exact collisions:
CREATE INDEX pages_content_hash_idx ON pages (content_hash);
```

Changes from the original brief's schema, with reasons:

| Change | Why |
|---|---|
| Added `status` | Encodes `generating` (reservation lock, [§3](#3-concurrency--idempotency)) and `taken_down` (reactive takedown). Moderation failures are not a status — they release the reservation for retry ([§7](#7-moderation)). |
| `content` / `content_hash` nullable | A reservation row exists before content does; placeholders have no content. |
| `seed_word` (retained, unused) | Was a logged entropy lever; the lever was removed ([generation.md](./generation.md)) but the column is kept nullable so existing provenance survives and re-introduction needs no migration. |
| Added `committed_at` | Distinguishes reservation time from commit time; aids stale-reservation reclaim. |
| Index on `content_hash` | Dedup ("hash check before storing") was specified but unindexed — it wouldn't scale without this. |

**Dedup rule:** before commit, `SELECT 1 FROM pages WHERE content_hash = $1 AND address <> $2`. On exact collision, regenerate once (a fresh sample — the prompt is identical, so this relies on model nondeterminism); near-duplicates are allowed (no fuzzy matching).

### `engagement` — research signal (🟡 deferred but reserved)

The brief calls for generation provenance to be *cross-referenced with engagement signals (e.g. dwell time)* as research data on what makes a page worth pausing on. That needs its own append-only table so the precious `pages` table stays small and write-light:

```sql
CREATE TABLE engagement (
  id          BIGSERIAL PRIMARY KEY,
  address     TEXT NOT NULL REFERENCES pages(address),
  dwell_ms    INTEGER,                 -- time on page
  arrived_via TEXT,                    -- 'random' | 'next' | 'typed' | 'reader'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

GDPR posture ([legal.md](./legal.md)): no user identifiers here — this is aggregate behavioral signal, not per-person tracking.

### Donations / fuel tank — ⚪ parked

Documented in [economics.md](./economics.md) but **deliberately not in the schema yet**. When built, it's an append-only `ledger` table (credits from donations, debits from spend) plus a payment-processor webhook; nothing else in the architecture needs to change to add it.

---

## 9. Permanence & backups

**The store is precious. Loss of the store = loss of the library. Regeneration is not a recovery plan** (the pages aren't reproducible — there's no seed, and the models drift).

- **Nightly backups are a charter requirement, not optional.** Neon provides point-in-time restore / branching; on top of that, a scheduled **`pg_dump` to off-provider object storage** (so a Neon-account-level failure isn't fatal) is the belt-and-suspenders posture for a permanent artwork.
- Backups are verified by periodic test-restores — an unrestorable backup is not a backup.
- Because pages are immutable after commit, backups are cheap and incremental in practice (the table only grows).

---

## 10. Economics enforcement

The numbers live in [economics.md](./economics.md); this section is **where they are enforced in the system.**

- **Per-visitor rate limit (~10 new pages/min):** enforced in `lib/` at admission control ([§2](#2-the-page-resolution-lifecycle) step 4), keyed by IP (no accounts exist). Cache hits and `next`/`random` to *existing* pages don't count — only generations. A small counter in Postgres or a KV/edge counter; Postgres is fine at this scale.
- **Monthly spend cap (~$10):** a running monthly spend counter, incremented per generation by `tokens × price`. Checked before each generation; when exceeded, the library flips to **explore-only mode** — cache hits still work, generation returns the "still-dark" response, and crucially the address is **not** crystallized so it can generate after the monthly reset.
- **Thundering-herd protection** ([§3](#3-concurrency--idempotency)) is itself an economic control — it guarantees one generation per address regardless of concurrent demand.

Both controls sit *after* the store lookup and *before* the LLM call, so they only ever gate the expensive path.

---

## 11. Runtime & deployment

- **Platform:** Vercel. Route handlers and server components become serverless functions automatically.
- **Function runtime: Node.js** (not Edge) for the resolution path — it uses the Postgres driver and `crypto` for hashing. Set `export const runtime = 'nodejs'` where needed.
- **Route handler caching (Next 16):** route handlers are **not cached by default** and run at request time — correct for our dynamic, store-backed generation. We deliberately do *not* `force-static` the generate path.
- **CDN caching of crystallized pages:** because a committed page is immutable, the page route can send long-lived `Cache-Control`/`s-maxage` headers so Vercel's CDN serves repeat visitors without invoking a function at all. This is what makes "cache hits are free" literally true and is the main cost lever as the library grows.
- **Postgres connections:** serverless functions are many and short-lived, which exhausts raw Postgres connections. Use **Neon's serverless/HTTP driver or a pooled (PgBouncer) connection string**, not a long-lived TCP pool. 🟢 Implemented as a tiny `pg` pool (max 3) behind `DATABASE_URL` in `lib/db.ts` — point it at Neon's **pooled** connection string in production; swapping to the Neon HTTP driver later is confined to that one file.
- **Environment variables (server-only):** `OPENROUTER_API_KEY` (🟢), `DATABASE_URL` (🟢, Neon pooled), `DEV_MODE` (model logging), generation levers (`GENERATION_MODELS`, `GENERATION_MODEL`, `GENERATION_TEMPERATURE`, `PAGE_MAX_WORDS`, `GENERATION_MAX_TOKENS`), moderation (`MODERATION_MODELS`, `MODERATION_POLICY`, `MODERATION_MAX_TOKENS`), concurrency tunables (`STALE_RESERVATION_SECONDS`, `GENERATION_WAIT_SECONDS`, `WAIT_POLL_INTERVAL_MS`), plus economic thresholds (Phase 6). All centralized in `lib/config.ts`; none are `NEXT_PUBLIC_*`.

---

## 12. Security

- **API keys never reach the client.** All provider calls originate in `lib/`/route handlers (server). The browser only ever sees rendered page text.
- **No accounts, minimal PII** ([legal.md](./legal.md)) — rate-limit keying on IP is the only quasi-identifier and isn't stored long-term.
- **Input handling:** the address is attacker-controlled (anyone can type a URL). It is normalized and length-bounded before it touches the store. It is *not* injected into the prompt (the page is never told its address), so prompt-injection via the address is not a vector — the only thing an address controls is which store key is read or written.
- **License:** **AGPL v3** — running a modified version as a network service obligates publishing source. Chosen to prevent closed commercial forks.

---

## 13. Scaling path

The design keeps the door open without paying for it now:

- All logic is in `lib/`, called by thin adapters → extracting to a standalone **Express/Fastify** service, **AWS Lambda**, or **Cloudflare Workers** is mostly lifting `lib/` and its two callers.
- The **DB is already external** (Neon) — no migration needed.
- **LLM and moderation calls are stateless** HTTP — they move with the code.
- The **CDN cache layer** ([§11](#11-runtime--deployment)) absorbs growth in read traffic independently of the generation backend.

No premature abstraction is warranted today; this is a record of *why* it stays cheap to scale later.

---

## 14. Known issues in the current prototype

🟢 What exists vs. what this doc targets:

| Current state | Target |
|---|---|
| `app/page.tsx` self-fetches `http://localhost:3000/api/generate` | Server component calls `resolvePage(address)` in `lib/` directly ([§1](#1-component-overview)) |
| `GET /api/generate` takes no address | Address-anchored generation via `[[...address]]` ([§5](#5-address-format--normalization)) |
| No store — every request generates anew | Generate-once / store-forever via Neon ([§2](#2-the-page-resolution-lifecycle)) |
| No moderation, no dedup, no rate limit, no spend cap | [§7](#7-moderation), [§8](#8-data-model), [§10](#10-economics-enforcement) |
| `layout.tsx` metadata still says "Create Next App" | Real title/description |

---

## Open architectural decisions

Tracked in [Roadmap](./roadmap.md); the ones this doc depends on:

- **Model tier** — stay on `:free` or move to a cheap paid model for latency/no-train ([§6](#6-generation-pipeline)).
- **Streaming exposure tradeoff** — live-stream-then-moderate vs. moderate-then-reveal ([§4](#4-streaming--moderation-interplay)).
- **Rate-limit / spend-cap store** — Postgres counter vs. edge KV ([§10](#10-economics-enforcement)).
