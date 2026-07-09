---
title: Experience
---

# Experience

## Navigation model

**Wandering-only**: random, next, typed address. No semantic text search, no reverse lookup.

This is a constraint, not a missing feature. Wandering is the only navigation because the library is not a retrieval system. You cannot look something up. You can only walk.

Addresses are **Borges-style coordinates** — `gallery / wall / shelf / volume / page` (see [Architecture §5](./architecture.md)). The space is ordered and bounded, so:

- **Random** — jump to a uniformly random coordinate
- **Next** — step to the next page in the volume (rolling over into the next volume, shelf, …); adjacency is real, so neighbors can share a volume
- **Typed address** — go to a specific coordinate you already know or were given

---

## The page as a fixed leaf

🟡 Provisional. Every page is the **same-sized container** — a fixed leaf — but holds a **variable amount of text** (a hard max, no minimum; see [Architecture §6](./architecture.md)).

A partial page is **intentional, not broken**. In real books a half-filled page means an ending — a chapter close, a poem, an epigraph; here it means the thought finished. The bar is *completeness, not fullness*: a page may be a single resonant line in a field of white, which is often exactly what produces the **pause** the success bar chases.

Rendering follows from this: text is **top-aligned** with honest whitespace below (so partial pages read as deliberate, not as errors), and the max is calibrated so full pages genuinely fill the leaf.

---

## The carried question

The visitor brings something unresolved into the library.

This is the primary use pattern: not finding, but wandering with intent. The question you carry shapes what you notice, not what the library shows you. It is a stance the visitor holds, not a feature the system reads — nothing watches you, and the library never knows what you came in with.

---

## Crystallization

When you arrive at an address that has never been visited, the page crystallizes. It did not exist before your arrival — not because the library generated it on demand, but because the library's principle of containing all possible pages only manifests when a page is walked into.

Being the **first visitor to an address is an event**. It may eventually be surfaced as such.

---

## The geological time experience

The library ages. Pages created early in the library's life are more coherent; pages created later are stranger. Visitors who return years later will feel the shift in texture. This is not a bug or drift — it is the library's natural aging, built into the entropy lever design.

See [Generation](./generation.md) for the mechanism.

---

## Success bar

A meaningful fraction of pages in a 20-page personal wander test should produce a pause — a moment where the reader finds themselves reading again, not sure why.

Not every page. Not most pages. A meaningful fraction. That is the bar.
