/**
 * The link-preview fetchers (LinkedIn, Slack, …) that app/robots.ts lets in
 * past its blanket disallow, and the matching user-agent test that
 * app/[[...address]]/page.tsx uses to answer them without a paid generation.
 * One list, so a bot is never allowed in without also being made free.
 */
export const UNFURL_BOTS = [
  "LinkedInBot",
  "Twitterbot",
  "facebookexternalhit",
  "Slackbot",
  "Discordbot",
  "TelegramBot",
  "WhatsApp",
];

const UNFURL_BOT_RE = new RegExp(UNFURL_BOTS.join("|"), "i");

export function isUnfurlBot(userAgent: string | null): boolean {
  return userAgent !== null && UNFURL_BOT_RE.test(userAgent);
}
