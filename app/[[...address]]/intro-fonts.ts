import { EB_Garamond, IBM_Plex_Mono } from "next/font/google";

/**
 * Fonts for the intro animation (intro.tsx, intro-scene.tsx) only — kept
 * out of app/layout.tsx so they're scoped to this route, not the whole
 * site, and in a server module (not the "use client" intro components) so
 * next/font's own module-eval requirements are trivially satisfied.
 *
 * The scene's character grid (CHAR_W = 11.1px at FS = 18.5px, exactly
 * 0.6em) is tuned to IBM Plex Mono's advance width — background rows lean
 * on the font's natural `white-space: pre` spacing, so a different mono
 * face would visibly mis-size the page block against PAGE_W. EB Garamond
 * is the serif used for the on-screen title lines.
 *
 * `preload: false`: this module is imported unconditionally by page.tsx,
 * so preloading would make every visitor fetch two faces that only
 * first-time visitors (the ones who see the intro) ever render.
 */
export const introMono = IBM_Plex_Mono({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-intro-mono",
  display: "swap",
  preload: false,
});

export const introSerif = EB_Garamond({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-intro-serif",
  display: "swap",
  preload: false,
});
