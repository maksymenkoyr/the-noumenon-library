/**
 * The first-visit intro's "already seen" flag (app/[[...address]]/intro.tsx),
 * following the noumenon: localStorage convention (lib/liked.ts).
 *
 * Navigation here is full page loads (app/[[...address]]/nav.tsx), so this
 * can't be read reactively inside the component the way marks.tsx reads a
 * like — a stable-false server snapshot would flash the overlay on and off
 * on every single page load for every returning visitor. Instead a small
 * blocking inline script in the root layout (app/layout.tsx) checks
 * INTRO_SEEN_KEY and stamps INTRO_SEEN_ATTR onto <html> before React
 * hydrates — the "preventing flash before hydration" pattern
 * (node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md)
 * — and globals.css hides `.intro-overlay` whenever that attribute is
 * present. The two files must stay in sync; the layout imports these
 * constants rather than duplicating the strings.
 */

export const INTRO_SEEN_KEY = "noumenon:seen-intro";
export const INTRO_SEEN_ATTR = "data-intro-seen";

/**
 * Marks the intro as seen: persists past this visit (for the layout's inline
 * script on the next page load) and hides it immediately for the rest of
 * this one, by setting the same attribute the script would have set.
 * No-ops quietly if storage is unavailable — a private-mode visitor simply
 * sees the intro again next time, never blocked by it (it's dismissible, not
 * a gate).
 */
export function markIntroSeen(): void {
  try {
    localStorage.setItem(INTRO_SEEN_KEY, String(Date.now()));
  } catch {
    /* best-effort; private-mode visitors just see the intro again next time */
  }
  document.documentElement.setAttribute(INTRO_SEEN_ATTR, "1");
}
