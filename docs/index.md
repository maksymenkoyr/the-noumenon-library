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
| [Experience](./experience.md) | Navigation model, the AI reader layer, and the user journey |
| [Economics](./economics.md) | API spend model, rate limits, and the fuel tank |
| [Legal & Safety](./legal.md) | Moderation, copyright, GDPR/DSA, and takedown policy |
| [Roadmap](./roadmap.md) | Open tickets, resolved decisions, and parked future ideas |

---

## Current State

A walkable library (M1 reached), now with a reading experience (Phase 5). You wander by address — random, next, or typed — and each address crystallizes once on first visit and persists forever. First visits reveal via a Suspense boundary (shell streams instantly, the leaf swaps in when it crystallizes); revisits load instantly. Moderation gates every commit; failures and takedowns render graceful placeholder leaves. See the [Roadmap](./roadmap.md) for what's next (economics & safety controls, permanence, the AI reader layer).

- **Runtime**: Next.js App Router + TypeScript + Tailwind
- **Store**: Neon Postgres (generate-once / store-forever)
- **Models in use**: a free-model generation pool (default `nvidia/nemotron-3-super-120b-a12b:free`) via OpenRouter; a separate free-model pool for moderation
- **Prompt in use**: see [Generation](./generation.md)
