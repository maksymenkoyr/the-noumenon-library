# The Noumenon Library

An infinite, shared, AI-generated library. Every URL is a coordinate on a shelf.
When you walk to an address nobody has visited before, the page there
**crystallizes** — it is generated once, stored, and from that moment exists at
that address forever, for every reader who comes after you.

There is one library, shared by everyone. Not a sandbox per visitor. Being the
first person to reach an address is an event, and the page you cause to exist is
the page everyone else will find.

Named after Kant's *noumenon* — the thing-in-itself, which exists independently
of anyone's perception and is never fully apprehended. The library pre-exists in
principle; it materializes as people walk it. No visitor can ever see the whole.

The premise is Borges' Library of Babel with the ratio inverted. Borges' library
holds every permutation of every character, so almost all of it is noise. Here
every page is coherent-but-strange — dreamlike, *meant*, crystallized out of
latent space rather than stumbled upon by chance. The claim is not that the
library contains all possible strings; it is that it contains all possible ideas
**within the horizon of human writing**. That horizon is the shape of machine
cognition, and it is part of the artwork rather than a flaw to hide.

## How you walk it

Three navigation modes, and only three: **random**, **next**, and **typed
address**.

There is deliberately no search, no content index, and no reverse lookup. This
is a constraint, not a missing feature — the library is not a retrieval system.
You cannot look something up. You can only walk.

A page can be **liked** (a personal keep, collected at `/liked`) or quietly
**reported**. Every page is a fixed-size container holding a variable amount of
text — a hard maximum, no minimum. A half-filled page is intentional: in real
books, a partial page means an ending. The bar is completeness, not fullness.

The quality bar the project actually aims at: in a 20-page wander, a meaningful
fraction of pages should produce a *pause* — the reader finds themselves reading
again, not sure why. The primary failure mode is "coherent but hollow."

## Addresses

```
/{gallery}/{wall}/{shelf}/{volume}/{page}      e.g.  /io-9/3/2/17/308
```

| Segment | Range | Source |
|---|---|---|
| `gallery` | `[a-z0-9-]`, 1–12 chars, no leading/trailing hyphen | the vast dimension — ~10¹⁸ galleries, but enumerable |
| `wall` | 1–4 | Borges |
| `shelf` | 1–5 | Borges |
| `volume` | 1–32 | Borges |
| `page` | 1–410 | Borges |

The space is finite, ordered, and closed. Gallery tokens enumerate as a
mixed-radix counter that grows the token on carry (`z` → `00`) and wraps at
`zzzzzzzzzzzz`, so **every address has a successor** and `next` is always
well-defined.

`normalizeAddress` ([`lib/address.ts`](lib/address.ts)) rejects rather than
repairs: `03`, `+3`, and `3.0` all 404 instead of silently aliasing onto another
URL's page. It is effectively permanent — changing it would orphan every stored
page — so it is locked by exhaustive tests.

**The address is never an input to generation.** It is only the storage key.
Pages are not told where they are, which is why neighbouring addresses are
thematically unrelated, and why prompt injection through the URL is not a vector.

## The four invariants

The app is small on the surface. The interesting part is what it has to
guarantee.

### 1. Same address → same page, forever

Permanence lives in the store, not in a seed. There is no PRNG that reproduces a
page; the only source of truth is the row in Postgres.

### 2. Never charge twice for one page

"First visit crystallizes the page" plus serverless equals a race: two visitors
arrive within the same second, both see a store miss, both call the LLM.

Resolved with Postgres as the lock ([`lib/store.ts`](lib/store.ts),
[`lib/resolvePage.ts`](lib/resolvePage.ts)). A store miss attempts
`INSERT … ON CONFLICT (address) DO NOTHING RETURNING address` for a
`status='generating'` placeholder. The request that gets a row back owns
generation; the losers poll for it to flip. A `generating` row older than
`STALE_RESERVATION_SECONDS` (default 90) is reclaimable, so a crashed generation
never wedges an address permanently, and a failed generation releases its
reservation immediately. N concurrent first-visitors collapse into exactly one
LLM call — which is also the primary spend control.

Admission control ([`lib/economics.ts`](lib/economics.ts)) sits after the store
lookup and before the LLM call, so cache hits are never charged and never
throttled:

- **Monthly spend cap** (default ~$10 USD) — one row per UTC month, incremented
  by `tokens × price` via atomic upsert. Over the cap the library degrades to
  explore-only, and the address is deliberately *not* crystallized so it can
  still generate after the reset.
- **Two-tier per-visitor rate limit** — a per-minute ceiling (default 5) *and* a
  per-hour ceiling (default 50) on one sliding-window counter, so pacing just
  under the minute limit doesn't escape entirely. The IP is salted-SHA256 hashed
  ([`lib/ipHash.ts`](lib/ipHash.ts)) before it touches the store, and rows
  outside the longest window are pruned opportunistically. Hits are recorded
  *before* generation runs, so failures still throttle crawlers.

### 3. Never store unmoderated content

[`lib/moderate.ts`](lib/moderate.ts) walks a short, curated chain of classifier
models in order until one returns a clear one-token `PASS`/`FAIL`; an abstain or
an error moves to the next link.

Deliberately **not** a parallel any-fail vote: every extra voter is another
chance to wrongly `FAIL` benign-but-dark content. Scope is narrow illegal
content only — **no aesthetic filtering.** Horror, obscenity, the disturbing and
the bleak are features of this library, and the classifier prompt says so
explicitly.

If every link abstains, the result is undetermined and `moderate()` throws. The
caller releases the reservation and the address is retried on a later visit — so
a transient provider outage never stores unmoderated content and never
permanently dark-shelves an address. In production, `MODERATION_ENABLED=false`
makes `moderate()` throw rather than pass, degrading the site to explore-only
instead of ever committing ungated text.

### 4. Never lose the store

Loss of the store is loss of the library, and **regeneration is not a recovery
plan** — there is no seed, and the models drift. So there are two independent
layers: Neon's point-in-time restore, plus a nightly `pg_dump -Fc` to Cloudflare
R2 (off-provider, so a Neon account-level failure isn't fatal).

An unrestorable backup is not a backup, so
[`.github/workflows/backup.yml`](.github/workflows/backup.yml) immediately
test-restores each fresh dump into a throwaway `postgres:17` service container
and asserts that the page count matches source and every committed page keeps
its `content_hash`. Failures ping a webhook.

## Generation

Pages are generated through an OpenAI-compatible client against two providers —
OpenRouter and Google Gemini — selected from a database-backed model registry
([`lib/registry.ts`](lib/registry.ts), `model_registry`).

The registry is keyed on `(slug, task)`, so one model can hold opposite settings
per role: Claude Haiku 4.5 has a generation row at temperature 0.9 in the
weighted lottery, and a moderation row at temperature 0 with a fixed chain
position and no variety at all.

- **Selection** is a weighted lottery with observed latency as a *bounded*
  tiebreak — `weight × clamp(REF_MS / avgMs, 0.8, 1.25)` — bounded on purpose so
  the fastest model can't eat the pool.
- **Health** is a state machine: `ok | cooling | unavailable`. A 429 parks the
  model until a backoff window elapses (honouring `Retry-After`, numeric or
  HTTP-date, else capped exponential backoff), a 404 retires it permanently.
  Recovery is lazy — the next real request just retries. No probe cron.
- **Fallback** falls through the shuffled remaining pool on any retryable error,
  so the variety lever doubles as the availability story. An empty completion
  counts as retryable, because generate-once/store-forever would make a blank
  page permanent.
- Every health and stats write is fire-and-forget and non-throwing: a registry
  hiccup must never break or slow a real generation.

The prompt ([`lib/prompts.ts`](lib/prompts.ts)) is treated as a first-class
artifact. Entropy levers — temperature jitter, model mixing, and a probabilistic
constraints pool where each constraint is a dial sampled per page — are logged
as provenance alongside every stored page, so the library's own drift stays
mappable. `npm run wander` walks N random addresses and emits scorable Markdown
with per-page provenance, which is how prompt changes are actually evaluated.

## Stack

| Piece | Choice |
|---|---|
| Framework | Next.js 16.2.7, App Router (`proxy.ts`, promise `params`, `connection()`) |
| UI | React 19.2.4, Tailwind CSS 4 |
| Language | TypeScript 5 (strict), ESLint 9 |
| Store | Postgres (Neon in prod, local Postgres in dev) via raw `pg` — no ORM |
| Schema | one idempotent [`lib/schema.sql`](lib/schema.sql): 14 tables, 4 views |
| LLM | `openai` SDK as a generic OpenAI-compatible client → OpenRouter, Google |
| Tests | Vitest 4 — 182 tests across 19 files |
| Hosting | Vercel (git-connected); GitHub Actions for migrations, backups, CI |
| Backups | Cloudflare R2 via `aws4fetch` |

All business logic lives in `lib/`; routes and components are thin adapters that
call the same functions. The server component `await`s `resolvePage()` directly
rather than fetching its own API route — self-fetching hardcodes a host and pays
a round-trip to talk to yourself.

## Running it locally

```bash
npm install
cp .env.example .env.local     # fill in the values you need
createdb noumenon              # any local Postgres
npm run db:migrate             # applies lib/schema.sql (idempotent)
npm run dev
```

At minimum set `DATABASE_URL` plus one of `OPENROUTER_API_KEY` /
`GOOGLE_API_KEY` to generate anything new. With no provider key configured the
app still serves already-crystallized pages — it just can't create new ones.

Every environment variable is **server-only**, read through
[`lib/config.ts`](lib/config.ts) with per-variable validation. There are no
`NEXT_PUBLIC_*` variables at all, so no provider key or secret can reach the
browser. See [`.env.example`](.env.example) for the annotated list.

The site can run behind a whole-site invite gate ([`proxy.ts`](proxy.ts),
[`lib/access.ts`](lib/access.ts)) using a stateless HMAC-signed cookie verified
with zero database lookups. It is **inert when `ACCESS_SIGNING_SECRET` is
unset**, which is the default for local dev.

### Tests

```bash
npm test
```

Unit tests run anywhere. The integration suites need a real Postgres — they
apply `lib/schema.sql` and `TRUNCATE` between cases, defaulting to
`postgres://localhost:5432/noumenon_test` and overridable with
`TEST_DATABASE_URL`. Because they share one database, `vitest.config.ts` sets
`fileParallelism: false`.

### Operational scripts

| Command | Purpose |
|---|---|
| `npm run db:migrate` | apply `lib/schema.sql` |
| `npm run invite` | mint an invite token for the access gate |
| `npm run takedown` | mark an address `taken_down` |
| `npm run backup` | `pg_dump` → R2 |
| `npm run restore:verify` | restore a dump and assert integrity |
| `npm run wander` | sample N random pages into a scorable report |

## Privacy

Reader-signal tables carry **no user identifiers**. Likes and dislikes are
aggregate counters, with per-reader state kept in `localStorage`. The reader
timeline in `page_events` is keyed by an ephemeral per-page-load
`crypto.randomUUID()` held in memory and never persisted client-side — not a
cookie, not a session token. Device is coarsened server-side to
`mobile | tablet | desktop` and the raw user-agent is never stored. Report rows
carry no identifiers.

Four SQL insight views (`page_signals`, `model_signals`, `variant_signals`,
`arrival_signals`) join generation provenance against those aggregate signals,
which is what makes it possible to ask which models and prompt variants actually
produce pages worth pausing on.

## License

[AGPL-3.0](LICENSE) — running a modified version as a network service obligates
publishing the source. Chosen to prevent closed commercial forks.
