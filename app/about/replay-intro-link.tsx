"use client";

import { clearIntroSeen } from "@/lib/intro";

/**
 * The permanent way back to the intro (app/[[...address]]/intro.tsx),
 * for anyone who didn't click the post-intro "play intro again?" nudge —
 * or wants it again later.
 *
 * A real anchor with a real `href="/"`, not a client-router push —
 * matching nav.tsx's own reasoning for keeping `/` a plain link: it "must
 * resolve a fresh address server-side per request", so this needs the same
 * real navigation a typed URL or shared link would get, not a client-side
 * shortcut. `onClick` runs synchronously before the browser's default
 * navigation fires, so the cookie clear is guaranteed to land before the
 * request goes out; page.tsx's `showIntro` (just "is this cookie absent")
 * does the rest, unchanged.
 */
export function ReplayIntroLink() {
  return (
    // A real anchor to "/" is the point (see the doc comment above), not a lint gap.
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    <a
      href="/"
      onClick={() => clearIntroSeen()}
      className="underline underline-offset-2"
    >
      watch the intro again →
    </a>
  );
}
