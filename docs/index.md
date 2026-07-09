---
title: The Noumenon Library
---

# The Noumenon Library

An infinite, shared, AI-generated library built on the Library of Babel concept. Every address yields a permanent, strange, coherent-but-dreamlike page — crystallized on first visit, stored forever.

Named after Kant's *noumenon*: the thing that exists beyond what can ever be fully perceived or known.

---

## Documentation

| Section | Description |
|---|---|
| [Concept](./concept.md) | What the library is, the core premise, and its philosophical grounding |
| [Architecture](./architecture.md) | Technical design, data model, and tech stack |
| [Generation](./generation.md) | Prompt engineering, entropy levers, and anti-patterns |
| [Experience](./experience.md) | Navigation model, the fixed-leaf reading experience, and the user journey |
| [Economics](./economics.md) | API spend model, rate limits, and the fuel tank |
| [Legal & Safety](./legal.md) | Moderation, copyright, GDPR/DSA, and takedown policy |
| [Operations](./operations.md) | Backups, test-restore, and error logging/alerting runbook |
| [Roadmap](./roadmap.md) | Open tickets, resolved decisions, and parked future ideas |

---

## Current State

A safe, sustainable, walkable library (**M2 reached**) in launch hardening. You wander by address — random, next, or typed — and each address crystallizes once on first visit and persists forever (first visits reveal via a Suspense boundary; revisits load instantly). Moderation gates every commit; failures and takedowns render graceful placeholder leaves. Economics & safety controls (rate limit + spend cap) and permanence (nightly off-provider backup + test-restore + alerting) are live. A legal footer / `/about` disclaimer and abuse-report path are in place. See the [Roadmap](./roadmap.md) for what remains before public launch (enabling moderation reliably, the success-bar eval, tuning).

- **Runtime**: Next.js App Router + TypeScript + Tailwind
- **Store**: Neon Postgres (generate-once / store-forever)
- **Models in use**: a free-model generation pool (default `nvidia/nemotron-3-super-120b-a12b:free`) via OpenRouter; a separate free-model pool for moderation
- **Prompt in use**: see [Generation](./generation.md)
