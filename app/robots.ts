import type { MetadataRoute } from "next";
import { UNFURL_BOTS } from "@/lib/unfurlBots";

/**
 * Crawler policy for the public deploy. The address space is effectively
 * infinite (lib/address.ts) and every novel address triggers a paid LLM
 * generation (lib/resolvePage.ts) — a well-behaved crawler walking `next →`
 * links from the random-redirect root would otherwise run up the monthly
 * spend cap (lib/economics.ts) on our behalf. Disallow everything except the
 * one static, cost-free route.
 *
 * Link-preview fetchers are the exception: they obey robots.txt too, so the
 * blanket disallow leaves a pasted link with no preview card at all. They
 * fetch only the pasted URL, never walk links, and the page route answers
 * them without generating (app/[[...address]]/page.tsx), so letting them in
 * costs nothing.
 *
 * Deliberately no sitemap: there is nothing enumerable worth publishing, and
 * listing committed addresses would invite exactly the crawl this file
 * refuses. Accepted tradeoff: the library itself is not discoverable via
 * search. This only binds well-behaved crawlers — the real backstop for
 * everyone else is the per-IP rate limit and the global spend cap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/about", disallow: "/" },
      { userAgent: UNFURL_BOTS, allow: "/" },
    ],
  };
}
