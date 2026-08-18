import type { MetadataRoute } from "next";

/**
 * Crawler policy for the public deploy. The address space is effectively
 * infinite (lib/address.ts) and every novel address triggers a paid LLM
 * generation (lib/resolvePage.ts) — a well-behaved crawler walking `next →`
 * links from the random-redirect root would otherwise run up the monthly
 * spend cap (lib/economics.ts) on our behalf. Disallow everything except the
 * one static, cost-free route.
 *
 * Deliberately no sitemap: there is nothing enumerable worth publishing, and
 * listing committed addresses would invite exactly the crawl this file
 * refuses. Accepted tradeoff: the library itself is not discoverable via
 * search. This only binds well-behaved crawlers — the real backstop for
 * everyone else is the per-IP rate limit and the global spend cap.
 *
 * Unfurl bots are the deliberate exception (§1.2, social preview): they also
 * respect robots.txt, so the blanket disallow above would silently keep the
 * new openGraph/twitter tags (app/layout.tsx, app/opengraph-image.tsx) from
 * ever being fetched when a link is pasted into Slack/Discord/etc. Each
 * fetches at most a couple of pages per shared link (the root redirect,
 * which is one generation, then the shared address itself if different) —
 * an accepted, small cost against the cap for a working preview.
 */
export default function robots(): MetadataRoute.Robots {
  const unfurlBots = [
    "Twitterbot",
    "facebookexternalhit",
    "Slackbot",
    "LinkedInBot",
    "Discordbot",
    "TelegramBot",
    "WhatsApp",
  ];
  return {
    rules: [
      { userAgent: "*", allow: "/about", disallow: "/" },
      ...unfurlBots.map((userAgent) => ({ userAgent, allow: "/" })),
    ],
  };
}
