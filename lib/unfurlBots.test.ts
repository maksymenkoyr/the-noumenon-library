import { describe, expect, it } from "vitest";
import { isUnfurlBot } from "./unfurlBots";

describe("isUnfurlBot", () => {
  it("matches the user agents the preview fetchers actually send", () => {
    expect(
      isUnfurlBot(
        "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
      ),
    ).toBe(true);
    expect(isUnfurlBot("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)")).toBe(true);
    expect(isUnfurlBot("facebookexternalhit/1.1")).toBe(true);
    expect(isUnfurlBot("WhatsApp/2.23.20.0")).toBe(true);
  });

  it("leaves browsers, search crawlers and a missing header alone", () => {
    expect(
      isUnfurlBot(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(isUnfurlBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(false);
    expect(isUnfurlBot(null)).toBe(false);
  });
});
