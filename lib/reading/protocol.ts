/**
 * The reading protocol: what the reader model is told at each stage, and how
 * its labeled-line replies are parsed. Mirrors `lib/moderate.ts`'s
 * classifier pattern (plain-text `FIELD: value` lines, tolerant parsing,
 * unmatched-or-"NOTHING" treated as an explicit non-answer) rather than JSON
 * mode, which nothing else in this codebase uses.
 *
 * The one rule everything here follows: reading stages OBSERVE, they never
 * JUDGE. No stage is ever asked whether the text is good or whether it
 * produced a pause — see ./verdict.ts for where that judgment actually
 * happens, deliberately outside this conversation.
 */

import type { StageId, StageWindow } from "./stages.ts";
import { peripheralNote, renderWindow } from "./stages.ts";

/** Bump when the prompts or field set change — a report's header prints
 * this, and runs at different versions must not be compared (plan
 * §"Provenance lock"). */
export const READER_PROTOCOL_VERSION = "reader-v1";

// Minimal, provider-agnostic content-part shape mirroring the OpenAI chat
// message content array. lib/reading/* must not import the `openai` package
// (purity rule) — scripts/read-eval.mts adapts this to the real SDK type at
// the call site. Kept as an array-of-parts (not a bare string) from day one
// so a later `{type:"image_url",…}` stage-0 input is additive, never a
// signature change — the Playwright-seam requirement from the plan.
export interface TextPart {
  type: "text";
  text: string;
}
export type ContentPart = TextPart;

function text(s: string): TextPart {
  return { type: "text", text: s };
}

/**
 * The reading-conversation system prompt. Deliberately withholds any
 * evaluation frame — the model is never told the text is generated, being
 * judged, or that anyone downstream cares what it says. Praise is a social
 * act; remove the social frame and most of it goes (plan §"Anti-flattery").
 */
export const READER_SYSTEM_PROMPT = [
  "You are a person at a screen. A link dropped you on a page of text you know",
  "nothing about — no title, no author, no byline, nobody watching. You have no",
  "obligation to read it and no reason to be kind to it.",
  "",
  "Report only what actually happens to you, moment to moment. Most pages you",
  "land on do nothing; saying so is the ordinary answer, not a failure. Never",
  "say whether the writing is good, never guess who wrote it or why, never",
  "summarize what you have not yet seen.",
  "",
  'Answer with exactly the labeled lines asked for, one per line, and nothing',
  'else. Where a field allows it, "NOTHING" is a complete and expected answer.',
].join("\n");

/** Field names asked at each stage family, in the order they're requested. */
export const LANDING_FIELDS = ["CAUGHT", "GUESS", "PULL", "NEXT"] as const;
export const SCREEN_FIELDS = ["STOPPED", "BACK", "WHY", "NEXT", "AT"] as const;
export const END_FIELDS = ["DRIFT", "BACK", "WHY", "END"] as const;
export const RECALL_FIELDS = ["IMAGE", "LINE", "FEEL"] as const;
export const PROBE_FIELDS = ["PICK", "SURE"] as const;
export const VERDICT_FIELDS = ["VERDICT", "EVIDENCE", "CONFIDENCE"] as const;

function stageFamily(id: StageId): "landing" | "screen" | "end" | "recall" | "probe" {
  if (id === "landing" || id === "end" || id === "recall" || id === "probe") return id;
  return "screen"; // screen-1, screen-2, …
}

/** The field set a given stage expects — used both to build the prompt and
 * to know which fields to parse out of the reply. */
export function fieldsFor(id: StageId): readonly string[] {
  switch (stageFamily(id)) {
    case "landing":
      return LANDING_FIELDS;
    case "screen":
      return SCREEN_FIELDS;
    case "end":
      return END_FIELDS;
    case "recall":
      return RECALL_FIELDS;
    case "probe":
      return PROBE_FIELDS;
  }
}

/**
 * Build the user-turn content for one reveal or blind stage. `probe` is
 * handled separately (`buildProbePrompt`) since its options come from
 * ./probe.ts's decoy selection, not from the page itself.
 */
export function buildStagePrompt(
  window: StageWindow,
  lines: string[],
): ContentPart[] {
  const family = stageFamily(window.id);
  const visible = renderWindow(lines, window);
  const note = peripheralNote(lines.length, window);

  switch (family) {
    case "landing":
      return [
        text([visible, "", note].join("\n")),
        text(
          [
            "You have had this in front of you for about two seconds. No longer.",
            "```",
            "CAUGHT: the words your eye actually landed on, verbatim from above — or NOTHING",
            "GUESS:  in five words or fewer, what you expect this page to be",
            "PULL:   one sentence — what makes you want the next line, or what makes you want to leave",
            "NEXT:   CONTINUE or STOP",
            "```",
          ].join("\n"),
        ),
      ];
    case "screen":
      return [
        text([visible, "", note].join("\n")),
        text(
          [
            "You have been on the page maybe eight seconds. You have skimmed this much.",
            "```",
            "STOPPED: up to three fragments, verbatim, where you actually slowed — or NOTHING",
            "BACK:    a line you went back over, verbatim — or NOTHING",
            "WHY:     CONFUSION (you lost the thread) or HOLD (you wanted it again) — omit if BACK is NOTHING",
            "NEXT:    CONTINUE or STOP",
            "AT:      if you stopped, the line you stopped at, verbatim — otherwise NOTHING",
            "```",
          ].join("\n"),
        ),
      ];
    case "end":
      return [
        text([visible, "", note].join("\n")),
        text(
          [
            "```",
            "DRIFT: the first fragment, verbatim, where your attention went elsewhere — or NOTHING",
            "BACK:  a line you went back over, verbatim — or NOTHING",
            "WHY:   CONFUSION or HOLD — omit if BACK is NOTHING",
            "END:   one sentence — what the last line did: landed, stopped, or trailed off",
            "```",
          ].join("\n"),
        ),
      ];
    case "recall":
      return [
        text(
          [
            "The tab is closed. The page is gone. Do not reconstruct it — report only",
            "what is actually still there.",
            "```",
            "IMAGE: one thing you can still see, one sentence — or NOTHING",
            "LINE:  any words you can still say back, verbatim — or NOTHING",
            "FEEL:  one word for what is left — or NOTHING",
            "```",
            "Most pages leave nothing. NOTHING is the ordinary answer.",
          ].join("\n"),
        ),
      ];
    case "probe":
      // Never reached — see buildProbePrompt.
      return [text("")];
  }
}

/** The forced-choice recognition probe (plan §"The recognition probe").
 * `options` is exactly 4 lines, already in their fixed A–D order; ./probe.ts
 * owns which one is real and which three are sibling-page decoys. */
export function buildProbePrompt(options: readonly [string, string, string, string]): ContentPart[] {
  const labels = ["A", "B", "C", "D"] as const;
  return [
    text(
      [
        "One of these four lines is from the page you just read. The other three",
        "are from other pages you have never seen.",
        "",
        ...options.map((o, i) => `${labels[i]}) ${o}`),
        "",
        "```",
        "PICK: A, B, C, or D",
        "SURE: YES or NO",
        "```",
      ].join("\n"),
    ),
  ];
}

/**
 * The verdict call's system prompt — a fresh, page-blind conversation (plan
 * §"Context carry"). Deliberately states no base rate: priming "most pages
 * are hollow" would manufacture the answer either direction. `VERDICT_BASE_RATE_HINT`
 * exists as a named, off-by-default lever so the effect of stating one can be
 * measured deliberately, rather than folded silently into the prompt.
 */
export const VERDICT_BASE_RATE_HINT = false;

export function buildVerdictSystemPrompt(): string {
  const hint = VERDICT_BASE_RATE_HINT
    ? "\n\nMost pages, historically, turn out hollow — weight your prior accordingly."
    : "";
  return [
    "You are reading a transcript of one person's pass over one page of text.",
    "You never see the page. Classify what happened to the reader, not what the",
    "page was like.",
    "",
    "A pause is when a reader finds themselves reading again, not sure why:",
    "something held them and something survived after the page was gone. Hollow",
    "is read-through-and-nothing-left. Bounce is left in the first seconds.",
    "```",
    "VERDICT:    PAUSE, HOLLOW, or BOUNCE",
    "EVIDENCE:   the single transcript field that decides it",
    "CONFIDENCE: HIGH or LOW",
    "```",
  ].join("\n") + hint;
}

// --- Reply parsing --------------------------------------------------------

/** A field's value: the trimmed text, or `null` when unmatched or an
 * explicit "NOTHING" — the same abstain-on-ambiguity spirit as
 * `lib/moderate.ts`'s `parseVerdict`. */
export type StageFieldValue = string | null;
export type StageReply = Record<string, StageFieldValue>;

const NOTHING_RE = /^nothing\.?$/i;

/** Parse `FIELD: value` lines out of a free-text reply, tolerant of extra
 * prose around them. A field that never matches, or whose value is empty or
 * "NOTHING", is `null`. */
export function parseStageReply(raw: string, fields: readonly string[]): StageReply {
  const result: StageReply = {};
  for (const field of fields) {
    const re = new RegExp(`^[ \\t]*${field}[ \\t]*:[ \\t]*(.*)$`, "im");
    const match = raw.match(re);
    if (!match) {
      result[field] = null;
      continue;
    }
    const value = match[1].trim().replace(/^["'“‘]+|["'”’]+$/g, "");
    result[field] = value === "" || NOTHING_RE.test(value) ? null : value;
  }
  return result;
}

/** True when every requested field came back null — the whole stage is an
 * abstain (e.g. an unparseable or refused reply). */
export function isAbstain(reply: StageReply, fields: readonly string[]): boolean {
  return fields.every((f) => reply[f] == null);
}
