---
title: Generation
---

# Generation

The generation prompt is **the highest-leverage artifact in the project**. It requires real iteration. Everything else can be changed; a poor prompt poisons every page.

---

## Current base prompt

> *You are a page in an infinite library. Every text that could ever be written already exists here. You do not know what you are. Generate the text found on this page.*

These base sentences are kept **verbatim** in the live `base-v1` variant (`lib/prompts.ts`), wrapped only with the page-size constraint:

```
You are a page in an infinite library. Every text that could ever be written
already exists here. You do not know what you are.

Generate the text found on this page. It may be a brief fragment or fill the
leaf, but no more than about {maxWords} words, and it must read as a finished
whole — never cut off mid-thought.
```

> **The page is told neither a seed word nor its address.** It does not know what it is or where it is, and so cannot narrate its own scaffolding (the early seed-word/coordinate prompts produced pages like *"anchored at the coordinate m4/2/3/5/100"* and *"a word surfaces as I am read: candle"* — exactly the self-orientation `"you do not know what you are"` exists to prevent). The **address is the storage key and navigation coordinate only — not a generation input.**

> **Implementation status:** levers live in `lib/generate.ts` (`chooseLevers` + `generatePage`); variant registry in `lib/prompts.ts`. Implemented: **`you do not know what you are`** (verbatim), **temperature** (default 0.9 — coherent start; env `GENERATION_TEMPERATURE`), and the **page-size constraint** (`PAGE_MAX_WORDS`, default 400). Because no seed word or address enters the prompt, **the prompt is identical for every page** — pages differ by the model's sampling nondeterminism alone. **Prompt variation is base-only for now** (one variant; structural mutations are the dormant lever). Provenance persisted on commit: `model`, `temperature`, `prompt_variant` (the `seed_word` column is kept but left null).

---

## Word choice matters

| Word | Effect |
|---|---|
| `written` | Pulls toward facts, documentation, reference material |
| `imagined` | Pulls toward interiority, inner states, dreams |
| `idea` | Acts as a hidden instruction — model tries to *have* one, produces formulaic output. **Avoid.** |

Framing the text as pre-existing (rather than being generated) frees the model from intentionality. *"Generate the text found on this page"* — not *"write a page."*

---

## Entropy levers

Entropy levers stack. The uncanny target zone lives in the middle of the journey from coherence toward strangeness.

| Lever | How it works |
|---|---|
| Temperature | Higher = stranger. Start coherent, drift over time. |
| Model selection | Different models have different gravity wells — combining them widens the range. |
| Prompt variation | Structural mutations to the base prompt. The prompt itself becomes entropy over time. |
| `"you do not know what you are"` | Removes the model's self-orientation; prevents purposeful generation. One of the most effective single phrases found so far. |

The single confirmed-effective lever in the live prompt is `"you do not know what you are"`; temperature and prompt variation are wired but not yet exercised for range (Phase 9 tuning).

### Removed: seed word injection

Appending a random word per generation was an early lever ("anchors the page without determining it"). **It was removed** — in practice the model *narrated* the word rather than letting it color the page (*"a word surfaces as I am read: candle"*), the same self-orientation failure as telling the page its address. Both were stripped so the page knows neither what nor where it is. The trade: with no per-page input, the prompt is identical for every page and the only deliberate source of variety is sampling nondeterminism until another lever (model mixing, prompt variation) wakes. Re-introducing a seed — injected so it shapes texture without being named — remains a possible future lever.

---

## Geological time

The library drifts toward strangeness as entropy levers accumulate over time:
- Early pages: more coherent
- Later pages: stranger
- Visitors returning years later feel the shift
- The uncanny target zone lives in the middle of that journey

This is intentional. The library ages. Its texture changes.

---

## Multi-model generation

Different models have different gravity wells — the latent space each model learned from is shaped differently. Mixing models across pages increases the range of page types and prevents the library from converging on one aesthetic.

> **Live (Phase 4).** Each page picks one model at random from a free-model pool (`GENERATION_MODELS`, e.g. `nvidia/nemotron-3-super-120b-a12b:free`, `meta-llama/llama-3.3-70b-instruct:free`, `qwen/qwen3-next-80b-a3b-instruct:free`) and logs it as the `model` provenance. This is the main deliberate variety lever now that the seed word is gone and the prompt is identical per page. Staying on **free models only** for now (no spend); under `DEV_MODE` the chosen model is console-logged.

Generation parameters are logged per page as provenance (see [Architecture](./architecture.md) store schema). Cross-referenced with engagement signals (dwell time) this becomes research data on what produces pages worth pausing on.

---

## Page size

🟡 Provisional. The page is a **fixed-size leaf** with a **hard maximum** and **no minimum** — same container, variable amount of text (see [Architecture §5–6](./architecture.md)). The prompt states the max explicitly.

The guarantee is **completeness, not fullness**: a page may end early and sit in white space, but must read as a finished artifact — never truncated mid-thought. A short, complete fragment is fine (often the most resonant kind of page); a cut-off page is the hollow failure mode below. Calibrate the max to actually fill the leaf at the display font so "full" pages look full.

To revisit after feel-testing — real books tend toward full pages, so the partial-page aesthetic needs to earn its keep.

---

## Primary failure mode

**Coherent but hollow** — readable, forgettable, empty.

A page that sounds like a library page without being one. The test: does it produce a pause? Does a reader find themselves reading it again?

The 20-page personal wander test: a meaningful fraction of pages in a 20-page wander should produce a pause.

---

## Anti-patterns

- Prompt that asks the model to *explain* or *describe* — produces encyclopedic output
- Mentioning the Library of Babel by name — model quotes Borges
- Asking for "a strange page" — model performs strangeness; hollow
- Using `idea` as an object noun — model tries to *have* an idea and announces it
