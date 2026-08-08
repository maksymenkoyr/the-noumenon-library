/**
 * Negative controls injected unlabeled into every run (plan §"Guards against
 * a confidently-wrong judge"). A `pause` verdict on any of these means the
 * run's judge cannot be trusted this time — scripts/read-eval.mts checks for
 * it and suppresses the tallies rather than printing a number nobody should
 * act on.
 */

import type { Rng } from "./rng.ts";
import { shuffle } from "./rng.ts";

/** Split prose into sentences: a run of non-terminator characters ending in
 * ./!/?, or a trailing fragment with no terminator at all. Naive on purpose —
 * good enough for shuffling, not a real sentence boundary detector. */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  return (matches ?? [text]).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Shuffle a real page's own sentences into a new order. Surface texture —
 * vocabulary, register, individual well-formed sentences — survives intact;
 * progression, the thing an ending needs the beginning for, is destroyed.
 * A near-perfect synthetic instance of "coherent but hollow." Text with
 * fewer than two sentences is returned unchanged (nothing to shuffle).
 */
export function shuffleSentences(text: string, rng: Rng): string {
  const sentences = splitSentences(text);
  if (sentences.length < 2) return text;
  return shuffle(sentences, rng).join(" ");
}

/**
 * Checked-in bland fixture texts: deliberately competent, deliberately
 * forgettable prose. Every run injects these unlabeled among the real
 * sampled pages as a fixed baseline for "this should never pause anyone."
 */
export const BLAND_CONTROLS: readonly string[] = [
  [
    "The meeting started on time. Sarah reviewed the quarterly numbers, which",
    "were in line with projections. Tom asked a clarifying question about the",
    "marketing budget, and Priya said she would follow up by email. The meeting",
    "ended at the scheduled hour, and everyone returned to their desks.",
  ].join(" "),
  [
    "He walked to the store and bought a loaf of bread, a carton of milk, and",
    "a bag of apples. The cashier said the total came to eleven dollars. He",
    "paid with a card, took the bag, and walked home the same way he had come.",
  ].join(" "),
  [
    "The report summarized three findings. First, response times had improved",
    "slightly over the previous quarter. Second, the improvement was not",
    "statistically significant. Third, further monitoring was recommended",
    "before drawing any conclusions.",
  ].join(" "),
];
