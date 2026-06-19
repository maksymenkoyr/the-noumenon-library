/**
 * Prompt variants — the prompt-variation entropy lever (docs/generation.md).
 *
 * The generation prompt is the highest-leverage artifact in the project, so
 * the base sentences are kept verbatim from generation.md ("you do not know
 * what you are" is a confirmed-effective phrase). The page is told neither a
 * seed word nor its address: it does not know what it is or where it is, and
 * must not narrate its own scaffolding. The address remains the storage key
 * and navigation coordinate only — it is not a generation input.
 *
 * Today there is a single variant; the registry exists so structural
 * mutations (e.g. an `imagined` sibling) can wake later without rework. The
 * chosen variant id is logged per page as provenance.
 */

export interface PromptContext {
  maxWords: number;
}

type PromptBuilder = (ctx: PromptContext) => string;

const VARIANTS: Record<string, PromptBuilder> = {
  "base-v1": ({ maxWords }) =>
    [
      "You are a page in an infinite library. Every text that could ever be " +
        "written already exists here. You do not know what you are.",
      "",
      "Generate the text found on this page. It may be a brief fragment or " +
        `fill the leaf, but no more than about ${maxWords} words, and it must ` +
        "read as a finished whole — never cut off mid-thought.",
    ].join("\n"),
};

export const DEFAULT_PROMPT_VARIANT = "base-v1";

export const PROMPT_VARIANT_IDS = Object.keys(VARIANTS);

export function buildPrompt(variantId: string, ctx: PromptContext): string {
  const builder = VARIANTS[variantId];
  if (!builder) {
    throw new Error(`Unknown prompt variant: ${variantId}`);
  }
  return builder(ctx);
}
