/**
 * The intro-animation cookie convention, shared by the server read
 * (app/[[...address]]/page.tsx, deciding whether to render the intro at
 * all) and the client write (intro.tsx, marking it seen). Pure module (no
 * node imports), like lib/liked.ts, so the client component can import it;
 * lib/devMode.ts is the server-only counterpart for its own cookie.
 *
 * Written on mount, not on completion or skip: a reader who reloads
 * mid-intro has already seen it start, so a fresh crystallizing page
 * shouldn't replay it from the top.
 */

export const INTRO_COOKIE = "noumenon_intro";

// A reader who clears cookies, or returns after a long break, sees the
// intro again — that's fine, it's a landing sequence, not a one-time
// tutorial gate.
const INTRO_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

/** Best-effort; a write failure (private mode, cookies disabled) just means the intro plays again next visit. */
export function markIntroSeen(): void {
  try {
    document.cookie = `${INTRO_COOKIE}=1; Path=/; Max-Age=${INTRO_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  } catch {
    /* best-effort */
  }
}

/**
 * The /about "watch the intro again" link (app/about/replay-intro-link.tsx):
 * clears the cookie client-side, then a plain `href="/"` does the rest —
 * `showIntro` in page.tsx is already just "is this cookie absent", so
 * clearing it here is the whole mechanism, no server-side plumbing needed.
 */
export function clearIntroSeen(): void {
  try {
    document.cookie = `${INTRO_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    /* best-effort */
  }
}
