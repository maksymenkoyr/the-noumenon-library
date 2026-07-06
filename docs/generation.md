---
title: Generation
---

# Generation

The generation prompt is **the highest-leverage artifact in the project**. It requires real iteration. Everything else can be changed; a poor prompt poisons every page.

---

## Current base prompt

> *An endless library holds every text that could ever be written. You are reading one page from it; set down exactly what is on it. You do not know what it is or where it sits.*

The live `base-v2` variant (`lib/prompts.ts`) frames the model as a **transcriber of a found page**, then injects a random **form/register** and the page-size constraint:

```
An endless library holds every text that could ever be written. You are reading
one page from it; set down exactly what is on it. You do not know what it is or
where it sits.

The writing on this page reads like {form}. It may be a brief fragment or fill
the leaf, but no more than about {maxWords} words, and it must read as a
finished whole — never cut off mid-thought.
```

> **Why the reframe (`base-v1` → `base-v2`).** The earlier prompt — *"You are a page in an infinite library … Generate the text found on this page"* — used a second-person "you **are** a page", which made the model narrate *being* a page (*"I am a page, thin and quiet…"*): the very self-orientation `"you do not know what you are"` was meant to prevent. `base-v2` makes the model a *reader/transcriber* of the page and re-aims the not-knowing at the page itself (*"you do not know what it **is**"*). The text is still framed as **found**, not written to order.

> **The page is still told neither its address nor a free "seed word".** The address is the storage key and navigation coordinate only. The one deliberate per-page input is the **form/register** (below) — a bounded register hint, not a coordinate or a noun to weave in — chosen so pages diverge instead of converging on one voice.

> **Implementation status:** levers live in `lib/generate.ts` (`chooseLevers` + `generatePage`); variant registry + form pool in `lib/prompts.ts`. Live levers: the **transcriber framing**, a random **form/register** (`GENERATION_FORMS`, ~30 kinds), **per-page temperature jitter** (base 0.9 ± `GENERATION_TEMPERATURE_JITTER`, default 0.2, clamped), **model selection** (currently pinned to one model — see below), and the **page-size constraint** (`PAGE_MAX_WORDS`, default 400). Provenance persisted on commit: `model`, `temperature` (the jittered value), `prompt_variant`, and the chosen **form** (stored in the reserved `seed_word` column).

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

Live levers now: the **transcriber framing** (replacing `"you do not know what you are"`, which invited self-narration), a random **form/register** per page, and **per-page temperature jitter**. Model mixing is wired but temporarily pinned to one model. Full range-tuning is still Phase 9.

### Seed word → form/register lever

Appending a random *word* per generation was an early lever ("anchors the page without determining it"). It was **removed** because the model narrated the word rather than letting it color the page (*"a word surfaces as I am read: candle"*) — the same self-orientation failure as telling the page its address.

It has been **revived in a safer shape**: instead of a bare noun to weave in, each page gets a random **form/register** — *"the writing on this page reads like a ship's log / an unsent letter / a legal statute / a lullaby …"* (`GENERATION_FORMS` in `lib/prompts.ts`, ~30 kinds spanning factual / interior / formal / vernacular). A register shapes *how* the page is written rather than naming a thing to be *about*, so it diversifies output without inviting narration. The chosen form is logged per page in the reserved `seed_word` column (research signal: which forms produce pages worth pausing on). **Caveat:** a register can still leak (a page may announce it is a ship's log); if that proves common, tighten the framing or drop the noisier forms. This is the main prompt-side variety lever while model rotation is pinned to a single model.

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
