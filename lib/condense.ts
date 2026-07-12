import { config } from "./config";
import type { GenerationUsage } from "./economics";
import { devLog } from "./log";
import { getOpenRouter } from "./openrouter";
import { buildCondenseMiddlePrompt } from "./prompts";

/**
 * Reverse-bell-curve condensation (docs/books.md). A page's condensed form
 * keeps its first and last sentences near-verbatim — the seams a neighboring
 * page must join onto — and aggressively summarizes only the middle. The
 * seams are extracted deterministically; the LLM is an enrichment for the
 * middle, never a dependency: any failure degrades to the extractive
 * head + "…" + tail, so condensation can never block or corrupt a commit.
 */

export interface Seams {
  head: string;
  middle: string;
  tail: string;
}

export interface CondenseResult {
  condensed: string;
  usage: GenerationUsage;
}

/** Seam budget: at most this many words verbatim on each end. */
const SEAM_MAX_WORDS = 40;

function words(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

function countWords(text: string): number {
  return words(text).length;
}

// Sentence boundary: terminal punctuation, optionally dressed in closing
// quotes/brackets, followed by whitespace.
const SENTENCE_SPLIT = /(?<=[.!?…]["'”’)\]]*)\s+/u;

/**
 * Split content into verbatim head/tail seams (1–2 sentences each, capped at
 * SEAM_MAX_WORDS) and the middle between them. Pure. Text too short to have
 * a distinct middle comes back whole as `head` with empty middle/tail —
 * already its own condensation. Punctuation-less text falls back to word
 * windows so a seam always exists.
 */
export function extractSeams(content: string): Seams {
  const trimmed = content.trim();
  const sentences = trimmed.split(SENTENCE_SPLIT).filter((s) => s.length > 0);

  if (sentences.length <= 1) {
    const all = words(trimmed);
    if (all.length <= SEAM_MAX_WORDS * 2) {
      return { head: trimmed, middle: "", tail: "" };
    }
    return {
      head: all.slice(0, SEAM_MAX_WORDS).join(" "),
      middle: all.slice(SEAM_MAX_WORDS, -SEAM_MAX_WORDS).join(" "),
      tail: all.slice(-SEAM_MAX_WORDS).join(" "),
    };
  }

  let headCount = 1;
  if (
    sentences.length > 2 &&
    countWords(`${sentences[0]} ${sentences[1]}`) <= SEAM_MAX_WORDS
  ) {
    headCount = 2;
  }
  const last = sentences.length - 1;
  let tailCount = 1;
  if (
    sentences.length - headCount > 2 &&
    countWords(`${sentences[last - 1]} ${sentences[last]}`) <= SEAM_MAX_WORDS
  ) {
    tailCount = 2;
  }

  if (headCount + tailCount >= sentences.length) {
    // Everything is seam — nothing left to condense.
    return { head: trimmed, middle: "", tail: "" };
  }

  return {
    head: sentences.slice(0, headCount).join(" "),
    middle: sentences.slice(headCount, sentences.length - tailCount).join(" "),
    tail: sentences.slice(sentences.length - tailCount).join(" "),
  };
}

/**
 * Join seams and middle summary with ellipsis markers. Pure. An empty middle
 * (extractive degrade) still leaves one "…" between head and tail so the
 * omission stays visible to the generating model.
 */
export function assembleCondensed(
  head: string,
  middleSummary: string,
  tail: string,
): string {
  return [head, middleSummary, tail]
    .filter((part) => part.trim().length > 0)
    .join("\n…\n");
}

function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Condense a committed page for use as neighbor context. Never throws.
 * A middle below config.condenseMinMiddleWords is kept as-is (the page is
 * short enough to be its own condensation — no LLM call, usage 0); otherwise
 * one low-temperature call summarizes the middle, and any failure or empty
 * reply degrades to the extractive head + "…" + tail.
 */
export async function condensePage(content: string): Promise<CondenseResult> {
  const usage: GenerationUsage = { tokens: 0, costUsd: 0 };
  const { head, middle, tail } = extractSeams(content);

  if (countWords(middle) < config.condenseMinMiddleWords) {
    return { condensed: content.trim(), usage };
  }

  try {
    const model = pick(config.generationModels);
    const response = await getOpenRouter().chat.completions.create({
      model,
      temperature: 0.2,
      // Cost backstop only; generous because reasoning tokens count (config.ts).
      max_tokens: config.maxTokens,
      messages: [
        {
          role: "user",
          content: buildCondenseMiddlePrompt(
            middle,
            config.condensedMiddleMaxWords,
          ),
        },
      ],
    });
    const tokens = response.usage?.total_tokens ?? 0;
    usage.tokens += tokens;
    usage.costUsd += (tokens / 1_000_000) * (config.modelPrices[model] ?? 0);

    const summary = response.choices[0]?.message.content?.trim() ?? "";
    if (summary) {
      return { condensed: assembleCondensed(head, summary, tail), usage };
    }
    devLog("condense: empty summary — degrading to extractive seams");
  } catch (error) {
    devLog(
      "condense: LLM failure — degrading to extractive seams:",
      error instanceof Error ? error.message : error,
    );
  }
  return { condensed: assembleCondensed(head, "", tail), usage };
}
