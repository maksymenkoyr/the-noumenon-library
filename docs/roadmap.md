---
title: Roadmap
---

# Roadmap

A phased build plan from the current prototype to a public, walkable library. Phases are ordered by dependency, not calendar — each lists its **goal**, **tasks**, what it **depends on**, and a **done-when** bar. Detail for each lives in [Architecture](./architecture.md); this is the sequencing layer.

> **Legend** — `[ ]` todo · `[~]` partial · `[x]` done. Section refs like [§5](./architecture.md) point into Architecture.

---

## Current state

- `[x]` Next.js 16 App Router + TypeScript + Tailwind scaffold
- `[x]` `GET /api/generate` calls OpenRouter and returns a page of text
- `[x]` All resolution logic flows through `lib/resolvePage`, called directly from server components
- `[x]` Address system live: `app/[[...address]]/page.tsx` + test-locked `lib/address.ts` (random / next / typed)
- `[x]` Page store live: generate-once/store-forever via `lib/store.ts` + `lib/resolvePage.ts` (Neon provisioned)
- `[x]` Generation pipeline live: lever-driven, provenance-logged, deduped, free-model rotation (`lib/pipeline.ts`) — **🏁 M1 reached**
- `[x]` Moderation live: free-model pool + policy gate, flag-and-retry on double-fail (monitoring event, no dark-shelf), reactive takedown script (`lib/moderate.ts`)
- `[x]` Dev mode (`DEV_MODE`) logs which model each call runs
- `[x]` Reading experience live: fixed-size leaf, typed/random/next navigation, Suspense-revealed first visit (shell streams instantly, leaf swaps in on crystallize), explore-only fallback (`app/[[...address]]/`) — **Phase 5**
- `[]` No rate limit / spend cap yet (Phase 6)

Everything above turns that single hardcoded call into the system described in [Architecture](./architecture.md); what remains is safety, economics, permanence, and the reading experience.

---

## Milestones

| Milestone                   | Reached after | Meaning                                                                                      |
| --------------------------- | ------------- | -------------------------------------------------------------------------------------------- |
| **M1 — Walkable library**   | Phase 3       | You can wander by address; pages generate once and persist. Private use; moderation stubbed. |
| **M2 — Safe & sustainable** | Phase 6       | Moderation, spend cap, and rate limits live. Safe to expose.                                 |
| **M3 — Public launch**      | Phase 9       | Backups, legal, reader layer, success-bar passed.                                            |

---

## Phase 0 — Foundation & cleanup

**Goal:** a clean spine to build on; no behavior change visible to a user.
**Depends on:** nothing.

- `[x]` Create `lib/` and move page-resolution logic out of routes/components ([§1](./architecture.md))
- `[x]` Replace `page.tsx` self-`fetch` with a direct `await resolvePage(address)` call ([§14](./architecture.md))
- `[x]` Fix `layout.tsx` metadata (still says "Create Next App")
- `[x]` Set `runtime = 'nodejs'` on the resolution path; establish env-var config (`OPENROUTER_API_KEY` ✓, add `DATABASE_URL`, model ids, thresholds) ([§11](./architecture.md))

**Done when:** the prototype behaves identically but all logic flows through `lib/resolvePage`, callable from both a server component and a route handler.

---

## Phase 1 — Address system

**Goal:** the library has coordinates; you can navigate them.
**Depends on:** Phase 0. **This phase is effectively permanent — lock it carefully.**

- `[x]` Decide `gallery` alphabet + length bound; decide whether to collapse `wall × shelf` into one 1–20 dimension ([§5](./architecture.md)) — locked: `[a-z0-9-]`, 1–12 chars, hyphen interior-only; wall × shelf kept separate
- `[x]` Implement `normalizeAddress(segments)` as a pure function — reject-don't-clamp out-of-range; **exhaustive tests** (changing this later orphans every page) — `lib/address.ts`, locked by `lib/address.test.ts` (`npm test`)
- `[x]` Routing: `app/[[...address]]/page.tsx` optional catch-all; `await params`
- `[x]` `randomAddress()` and `nextAddress(addr)` (page→volume→shelf→… rollover)
- `[x]` Minimal render: show generated text for a typed/random address (still regenerating per visit — store comes next)

**Done when:** typing `/io-9/3/2/17/308`, hitting random, and stepping "next" all resolve to a page; normalization is test-covered and frozen.

---

## Phase 2 — Page store (Neon Postgres)

**Goal:** generate-once, store-forever. Same address → same page.
**Depends on:** Phase 1 (address is the primary key).

- `[x]` Provision Neon; wire pooled/serverless connection driver ([§11](./architecture.md)) — `pg` behind `DATABASE_URL` in `lib/db.ts`; Neon provisioned (pooled string in `.env.local`), schema migrated and verified end-to-end
- `[x]` Create `pages` table per the [§8](./architecture.md) schema (`status`, nullable `content`/`content_hash`, provenance cols, `content_hash` index) — `lib/schema.sql`, applied via `npm run db:migrate` (idempotent)
- `[x]` `getPage` (store lookup) + `commitPage` (write final state) — `lib/store.ts`
- `[x]` Reserve-then-generate concurrency guard: `INSERT … ON CONFLICT DO NOTHING`, wait-for-winner, stale-reservation reclaim ([§3](./architecture.md)) — stale window is env-tunable (`STALE_RESERVATION_SECONDS`, default 300 s while the `:free` reasoning model takes minutes; tighten with the model tier)
- `[x]` Wire the full lifecycle into `resolvePage`: lookup → reserve → generate → commit ([§2](./architecture.md)) — done-when bar locked by `lib/resolvePage.test.ts`

**Done when:** revisiting an address returns the identical stored page with no LLM call; two concurrent first-visitors trigger exactly one generation.

---

## Phase 3 — Generation pipeline · 🏁 M1

**Goal:** pages are address-anchored, varied, and provenance-logged.
**Depends on:** Phase 2.

- `[~]` ~~Inject the normalized address into the prompt as the creative anchor~~ — **reversed.** The address is the store key + navigation coordinate only; it is *not* injected (the page narrated its own coordinate). See [§5](./architecture.md), [Generation](./generation.md)
- `[x]` Entropy levers as config: `model`, `temperature`, `prompt_variant` — `chooseLevers()` in `lib/generate.ts`. **Variant is base-only (`base-v1`, the `written` prompt) for now; the registry holds one entry so the `imagined`/variation lever can wake later.** The **seed word lever was removed** (the page narrated it); no per-page input now, so pages differ by sampling alone
- `[x]` Page-size constraint in the prompt: hard max, no min, "complete not truncated" ([§6](./architecture.md)) — `PAGE_MAX_WORDS` (default 400) in the prompt; `GENERATION_MAX_TOKENS` (default 4000) is only a cost backstop, deliberately generous for the reasoning model
- `[x]` Persist provenance (`model`, `temperature`, `prompt_variant`) on commit — `commitPage` in `lib/store.ts` (the `seed_word` column is retained but left null)
- `[x]` Dedup: `content_hash` collision check → regenerate once with fresh seed ([§8](./architecture.md)) — `contentExistsElsewhere` + retry in `lib/pipeline.ts`
- `[x]` Stub `moderate()` as always-pass for now (real version in Phase 4) — `lib/moderate.ts`

**Done when:** different addresses reliably yield different pages, every page row carries full provenance, and a 20-page private wander is possible. **🏁 M1 — walkable library. ✅ Reached.**

---

## Phase 4 — Moderation

**Goal:** never store unmoderated content. Required before any public exposure.
**Depends on:** Phase 3.

- `[x]` Implement `moderate(text)` as a secondary LLM yes/no call, narrow illegal-content scope only ([§7](./architecture.md), [Legal](./legal.md)) — `lib/moderate.ts`. **A pool of free models** (`MODERATION_MODELS`, mixed deterministic/non) run in parallel; verdicts combine via `MODERATION_POLICY` (default `any-fail`); undetermined (all abstain) → throw → retry later
- `[x]` Flow: fail → regenerate once (fresh sample) → second fail → emit `moderation_persistent_reject` (`lib/monitor.ts`) + throw → reservation released, retried later (no dark-shelf) — `lib/pipeline.ts`
- `[x]` Taken-down placeholder rendering — `resolvePage` returns `{status, text}`; `app/[[...address]]/page.tsx` renders it muted/italic
- `[x]` Reactive-takedown path: set `status = taken_down` by address ([Legal](./legal.md)) — `takeDownPage` (upsert) + `npm run takedown -- <address>` script

**Done when:** failing content is never persisted as `ok`; persistent rejects are flagged for human review; takedown resolves to a placeholder. **✅ Met.**

**Also landed this phase (user-requested):** free-model **generation rotation** (`GENERATION_MODELS` — the dormant "different gravity wells" variety lever woke; chosen model logged as provenance) and **dev mode** (`DEV_MODE`; console-logs which model each generation/moderation runs).

---

## Phase 5 — Reading experience & streaming

**Goal:** the page _feels_ like a page; first-visit latency is masked.
**Depends on:** Phases 3–4.

- `[x]` Fixed-size leaf rendering: top-aligned text, honest whitespace, max calibrated to fill at display font ([Experience](./experience.md)) — `app/[[...address]]/leaf.tsx` (`Leaf`/`CrystallizingLeaf`/`PlaceholderLeaf`, shared `LEAF_HEIGHT` so no layout shift); serif reading face (`Lora`) via `app/layout.tsx`
- `[x]` Navigation UI: random / next / typed-address controls — `app/[[...address]]/nav.tsx` (`"use client"`); typed input reuses the pure `lib/address.ts` `normalizeAddress` to validate inline, full-page navigation to keep `random` re-resolving server-side
- `[~]` ~~Stream generation live to the first visitor~~ — **landed as Suspense reveal, not live token streaming** (decided: the `:free` reasoning model emits reasoning tokens before any page text, so token-by-token adds little now). The shell (address + nav) streams instantly; the finished leaf swaps into a `<Suspense>` boundary when generation completes. Moderation already gates the commit (Phase 4). The same UI can host true token streaming later with no rewrite ([§4](./architecture.md))
- `[x]` Explore-only state surfaced in the UI — a render-only state (no row persisted): a generation/moderation failure or wait-timeout from `resolvePage` renders the explore-only leaf instead of an error page; the Phase 6 spend cap will reuse it

**Done when:** a first visit streams in and reads as a finished leaf; revisits load instantly; partial pages look deliberate. **✅ Met** (shell + crystallizing fallback flush at ~0.5 s, leaf streams in on completion; cache hit renders synchronously with no fallback flash).

---

## Phase 6 — Economics & safety controls · 🏁 M2

**Goal:** the library can't be bankrupted or crawled.
**Depends on:** Phases 2–3.

- `[ ]` Per-visitor rate limit (~10 new pages/min, IP-keyed; only generations count) ([§10](./architecture.md))
- `[ ]` Monthly spend counter (`tokens × price`); cap → explore-only mode (no crystallization past the cap)
- `[ ]` Decide counter store: Postgres vs. edge KV
- `[ ]` CDN cache headers on committed pages so repeat reads skip the function ([§11](./architecture.md))

**Done when:** generation halts cleanly at the cap with cache hits still served, and a crawler can't exceed the rate limit. **🏁 M2 — safe & sustainable.**

---

## Phase 7 — Permanence & ops

**Goal:** the precious store cannot be lost.
**Depends on:** Phase 2.

- `[ ]` Nightly `pg_dump` to off-provider object storage (beyond Neon's own PITR) ([§9](./architecture.md))
- `[ ]` Periodic automated **test-restore** (an unrestorable backup is not a backup)
- `[ ]` Basic error logging/alerting on generation, moderation, and DB failures

**Done when:** a verified, off-provider, restorable nightly backup exists and is monitored.

---

## Phase 8 — AI reader layer

**Goal:** the AI-as-reader companion central to the premise ([Experience](./experience.md)). Independent of the launch-critical infra above — can move earlier if desired.
**Depends on:** Phase 3 (pages must exist).

- `[ ]` `POST /api/reader`: interpret a page, surface resonant lines, suggest where to walk next — reads, does not generate the library
- `[ ]` "Carried question" input the reader watches for resonance against
- `[ ]` Reader UI alongside the page

**Done when:** on a given page the reader produces a plausible interpretation, a surfaced line, and a next-step suggestion.

---

## Phase 9 — Launch hardening · 🏁 M3

**Goal:** ready for the public.
**Depends on:** Phases 4, 6, 7.

- `[ ]` Legal: machine-generated-fiction disclaimer, non-commercial notice, copyright/abuse report mechanism wired to the takedown path ([Legal](./legal.md))
- `[ ]` Confirm moderation is live (not stubbed) and DSA/GDPR posture documented
- `[ ]` Success-bar test: a meaningful fraction of pages produce a pause across a 20-page wander ([Experience](./experience.md))
- `[ ]` Tune model tier / temperature for the coherence-to-strangeness target zone ([Generation](./generation.md))

**Done when:** the success bar is met and the library is safe, backed up, and legally covered. **🏁 M3 — public launch.**

---

## Resolved decisions

| Decision               | Resolution                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Generation prompt base | Established — see [Generation](./generation.md)                                             |
| Entropy levers         | Transcriber framing + random **form/register** (`GENERATION_FORMS`) + **per-page temperature jitter** + model rotation; **address is not injected**. The removed seed word returned as the bounded form/register lever (logged in `seed_word`). Reframed from `"you do not know what you are"`, which invited "I am a page" self-narration |
| Prompt variant         | `base-v2` (transcriber framing + injected form); registry ready for more mutations |
| Generation temperature | Base 0.9, jittered ±`GENERATION_TEMPERATURE_JITTER` (default 0.2) per page; retuned in Phase 9 |
| Generation models      | Free-model pool picked at random per page — **temporarily pinned to `nemotron:free`** while the others 429 (docs/generation.md) |
| Navigation model       | Wandering-only (random / next / typed address); no semantic search                          |
| Address topology       | Human-scaled Borges coordinates: `gallery/wall/shelf/volume/page` ([§5](./architecture.md)) |
| Gallery token format   | Lowercase `[a-z0-9-]`, 1–12 chars, hyphen never first/last; lowercasing is the only normalization transform |
| Wall × shelf           | Kept separate (wall 1–4, shelf 1–5) — Borges fidelity; not collapsed                        |
| Random distribution    | Gallery length uniform first, then chars — typeable landings over strict uniformity         |
| Library closure        | Finite and toroidal: `next` past the last address wraps to `0/1/1/1/1`                      |
| Page model             | Fixed-size leaf, variable text (hard max, no min) — provisional, see Phase 5                |
| Permanence model       | Store-based, not algorithmic seeding                                                        |
| Page store             | Neon Postgres                                                                               |
| LLM provider           | OpenRouter (swappable; model tier to revisit for latency)                                   |
| Model tier             | Free models only for now (no spend), both generation and moderation                         |
| Moderation method      | Pool of free LLMs (mixed deterministic/non) → PASS/FAIL combined by policy (default `any-fail`); narrow illegal-content only; undetermined → retry, never store unmoderated |
| Reactive takedown      | `npm run takedown -- <address>` script (no admin HTTP endpoint — would be an abuse vector); intake UI deferred to Phase 9 |
| Dev mode               | `DEV_MODE` env (auto-on outside production) → console-logs which model each call runs        |
| License                | AGPL v3                                                                                     |
| Funding model          | Public donation fuel tank; no subscription (system parked)                                  |
| Multi-user model       | One shared canonical library; no per-user sandboxes                                         |

---

## Provisional / to revisit

- **Page-size aesthetic** — validate partial pages against the "books are usually full" instinct; may add a soft minimum (Phase 5). `PAGE_MAX_WORDS` default 400, env-tunable
- **Model tier** — **free models only for now** (no spend, both generation and moderation). Revisit a cheap paid tier for latency/no-train at Phase 9. The `:free` nemotron is a reasoning model: first-gen takes ~10s+ and emits reasoning tokens (hence the generous `GENERATION_MAX_TOKENS` backstop). Free-tier moderation also has availability gaps — the parallel pool + `any-fail`/undetermined-retry posture is the mitigation
- **Moderation policy** — default `any-fail` (safety-first) may over-block during free-model experimentation, creating permanent dark shelves; the pool/policy is env-tunable while it's being A/B'd
- **Prompt variation** — wake the dormant lever (e.g. `imagined` sibling, structural mutations) once the base texture is feel-tested (Phase 9)
- **Streaming exposure** — live-stream-then-moderate vs. moderate-then-reveal ([§4](./architecture.md))

---

## Backlog — unscheduled features

Concrete features to build eventually; smaller than a phase, not yet slotted. Captured so they're not lost.

### Page "like" / resonance mark

Let a visitor mark a page that gave them a pause — the exact signal the [success bar](./experience.md) chases.

- **Model:** no accounts, so it's an **aggregate** signal (a like count per address), not per-person. Throttle by IP-hash to blunt trivial gaming; decide whether the count is public on the leaf or a private research signal.
- **Where it hooks in:** the reserved `engagement` table ([Architecture §8](./architecture.md)) — add a reaction/like signal alongside `dwell_ms`/`arrived_via`. Cross-referenced with generation provenance (now including the `form`/register), this becomes direct data on *what makes a page worth pausing on*.
- **UI:** a subtle control on the leaf, in keeping with the quiet aesthetic.
- **Open:** GDPR posture (aggregate / IP-hashed, no identifiers — see [Legal](./legal.md)); public count vs. private; abuse throttling.

### History navigation (back / forward through your trail)

Make the wander legible as a **path**: explicit "← back / forward →" through the addresses *this visitor* has walked — distinct from **next →**, which is the library's own address-space successor, not personal history. The two are different axes and are currently easy to conflate.

- **Where it hooks in:** navigation is `random / next / typed` today ([`app/[[...address]]/nav.tsx`](../app/[[...address]]/nav.tsx)), via full-page loads (plain anchors, no client history stack). Back/forward needs a **per-visitor trail** the server doesn't keep — hold it client-side (the browser History API and/or `sessionStorage`).
- **UX:** clarify the distinction in the chrome so "next" (adjacent leaf) and "back/forward" (your own steps) never read as the same control. Browser back already works for full-page nav; an explicit in-app control makes "you are wandering a path" felt.
- **Open:** whether the trail persists across sessions; how it interacts with `random` (each random is a new branch); surfacing "first visitor to this address" events ([Experience](./experience.md)) along the trail.

---

## Parked future ideas

Out of scope for the current version. Do not pull into active work without a separate design pass.

### Algorithmic version

PRNG + rich word pools, AI as guide/reader layer only. Preserves mathematical completeness (all possible strings) rather than experiential completeness.

### Algorithm iteration series

Progressive steps from pure gibberish toward coherence — a companion exhibit showing the library's construction.

### Book-length AI version

Sections, variable length, more literary structure. Longer-form reading experience. Would rethink the address system.

### Hybrid free-form addressing

Map typed _phrases_ into gallery coordinate space, on top of the coordinate system ([§5](./architecture.md)).

### Paid tier / monetization

Deferred. Do not design for this yet.

### Fuel tank / donations system

Concept documented in [Economics](./economics.md); schema + payment webhook deliberately not built yet ([§8](./architecture.md)).
