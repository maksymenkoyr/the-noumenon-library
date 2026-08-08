/**
 * Layout constants for the reading-simulation eval (docs/reference/experience.md,
 * scripts/read-eval.mts). Derived from the actual rendered page — never from the
 * docs, which have drifted (see the plan's "Docs drift" risk note) — so that
 * `wrapText()` (./wrap.ts) reproduces roughly what a real visitor's browser wraps
 * to. This is a simulation, not a measurement: the Playwright seam (./stages.ts
 * `Renderer`) exists precisely to replace this with true `getClientRects()` output
 * later.
 *
 * Sources, read at the time this file was written:
 *   - app/[[...address]]/page.tsx:62-63
 *       <main className="mx-auto flex w-full max-w-2xl grow flex-col gap-8 p-8">
 *       <header className="flex items-baseline gap-4 font-mono text-sm …">
 *   - app/[[...address]]/page-content.tsx:20 (article)
 *       "min-h-[44rem] whitespace-pre-wrap font-serif text-lg leading-loose …"
 *   - Tailwind v4 defaults, 16px root font, no size overrides in app/globals.css.
 *
 * If any of those class names change, these constants go stale silently — there
 * is no build-time link between them. Re-derive by hand (or, once it exists, by
 * running the Playwright renderer once and diffing) after any layout change to
 * app/[[...address]]/page.tsx or page-content.tsx.
 */

export type ViewportProfile = "desktop" | "laptop" | "mobile";

/**
 * What a reader saw when a page was rendered, at one viewport profile — the
 * Playwright seam (docs: plan §"The Playwright seam"). `./wrap.ts`'s
 * `simulatedRenderer` produces this today from computed line-wrapping; a
 * future `browserRenderer` would produce the same shape from a real
 * `getClientRects()` read of the rendered `<article>`, with `images` populated
 * for a vision-model stage-0 input. Everything downstream of a renderer
 * (`./stages.ts` in particular) consumes only this shape, never raw text, so
 * swapping renderers touches nothing else.
 */
export interface PageSnapshot {
  /** Rendered lines in reading order — one entry per line box. */
  lines: string[];
  /** Index of the first line at/below the fold; equals `lines.length` when
   * the whole page fits above the fold. */
  foldLine: number;
  profile: ViewportProfile;
  /** Per-stage-window screenshots, data URLs — vision-renderer path only. */
  images?: string[];
}

export interface Renderer {
  render(text: string, address: string, profile: ViewportProfile): Promise<PageSnapshot>;
}

interface ProfileSpec {
  /** CSS pixel viewport, matching a Playwright `viewport` option shape. */
  readonly width: number;
  readonly height: number;
  /**
   * Article top offset in px: the vertical space above the first line of text.
   * `p-8` (32px) + header row height + `gap-8` (32px) between header and
   * article. The header is one line (20px, `text-sm` leading-none-ish ≈ its
   * font size) on desktop/laptop; on a 390px-wide viewport the header's
   * address + nav wrap to two rows, adding one more line (~20px).
   */
  readonly articleTop: number;
  /** Usable content width in px available to the article's text, i.e. the
   * container width (`max-w-2xl` = 672px, or the viewport width if narrower)
   * minus `p-8` horizontal padding on both sides (64px). */
  readonly contentWidth: number;
}

// text-lg = 1.125rem = 18px; leading-loose = unitless line-height 2.
export const FONT_PX = 18;
export const LINE_PX = FONT_PX * 2; // 36px per line box

// Mean glyph advance for Latin prose set in a text serif (Lora), including
// inter-word spaces, clusters around 0.50em. This is the single most
// approximate number in the whole module — see the Playwright seam note above.
const MEAN_CHAR_EM = 0.5;
const CHAR_PX = MEAN_CHAR_EM * FONT_PX; // 9px

const MAX_CONTAINER_PX = 672; // max-w-2xl
const CONTAINER_PADDING_PX = 64; // p-8 * 2 (horizontal)
const TOP_PADDING_PX = 32; // p-8 (vertical)
const HEADER_LINE_PX = 20; // font-mono text-sm, one row
const HEADER_GAP_PX = 32; // gap-8 between header and article

function contentWidthFor(viewportWidth: number): number {
  return Math.min(viewportWidth, MAX_CONTAINER_PX) - CONTAINER_PADDING_PX;
}

export const VIEWPORT_PROFILES: Readonly<Record<ViewportProfile, ProfileSpec>> = {
  desktop: {
    width: 1440,
    height: 900,
    articleTop: TOP_PADDING_PX + HEADER_LINE_PX + HEADER_GAP_PX, // 84
    contentWidth: contentWidthFor(1440), // 608 (capped by max-w-2xl)
  },
  laptop: {
    width: 1280,
    height: 800,
    articleTop: TOP_PADDING_PX + HEADER_LINE_PX + HEADER_GAP_PX, // 84
    contentWidth: contentWidthFor(1280), // 608 (capped by max-w-2xl)
  },
  mobile: {
    // The header (address + Nav) wraps to two rows below ~430px, per the
    // component's `flex items-baseline gap-4` with no explicit wrap opt-out.
    width: 390,
    height: 745, // iPhone-class viewport minus browser chrome, roughly
    articleTop: TOP_PADDING_PX + HEADER_LINE_PX * 2 + HEADER_GAP_PX, // 104
    contentWidth: contentWidthFor(390), // 326
  },
};

/** Characters per wrapped line at a viewport profile, floored. */
export function charsPerLine(profile: ViewportProfile): number {
  return Math.floor(VIEWPORT_PROFILES[profile].contentWidth / CHAR_PX);
}

/** Number of full line boxes visible above the fold at a viewport profile. */
export function foldLines(profile: ViewportProfile): number {
  const { height, articleTop } = VIEWPORT_PROFILES[profile];
  return Math.floor((height - articleTop) / LINE_PX);
}

/**
 * Lines covered by an initial ~2-second landing gaze: one fixation plus a
 * couple of short saccades. Deliberately small and deliberately a named,
 * overridable constant — the report prints it, and the whole harness is most
 * sensitive to this number (see the plan's "Docs drift" / landing-boundary
 * risk note).
 */
export const LANDING_LINES = Number(process.env.READ_EVAL_LANDING_LINES ?? 3);
