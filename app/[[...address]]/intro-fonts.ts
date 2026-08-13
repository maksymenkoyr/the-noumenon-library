import { IBM_Plex_Mono } from "next/font/google";

/**
 * The one font the intro animation (intro.tsx, intro-scene.tsx) needs of
 * its own — kept out of app/layout.tsx so it's scoped to this route, not
 * the whole site, and in a server module (not the "use client" intro
 * components) so next/font's own module-eval requirements are trivially
 * satisfied.
 *
 * The scene's character grid (CHAR_W = 11.1px at FS = 18.5px, exactly
 * 0.6em) is tuned to IBM Plex Mono's advance width — background rows lean
 * on the font's natural `white-space: pre` spacing, so a different mono
 * face would visibly mis-size the page block against PAGE_W.
 *
 * The narration (the big line + the five example titles) used to load its
 * own EB Garamond here too; it's set in Lora now — the site's own reading
 * serif (--font-serif, app/layout.tsx), already loaded globally, so it
 * costs nothing extra and speaks in the same voice as the pages themselves.
 *
 * `preload: false`: this module is imported unconditionally by page.tsx,
 * so preloading would make every visitor fetch a face that only
 * first-time visitors (the ones who see the intro) ever render.
 */
export const introMono = IBM_Plex_Mono({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-intro-mono",
  display: "swap",
  preload: false,
});
