import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { monitor } from "./monitor";

/**
 * The throttle Map is module-level and persists across tests in this file, so
 * every test uses a unique event name rather than a shared reset hook — that
 * keeps the throttle's real cross-call behavior under test instead of stubbing
 * it away.
 */
describe("monitor", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function enableTelegram() {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
    vi.stubEnv("TELEGRAM_CHAT_ID", "42");
  }

  it("always logs one line of structured JSON tagged type=monitor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_CHAT_ID", "");
    await monitor("log_shape", { address: "io-9/3" });

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][0] as string);
    expect(logged.type).toBe("monitor");
    expect(logged.event).toBe("log_shape");
    expect(logged.address).toBe("io-9/3");
    expect(typeof logged.ts).toBe("string");
  });

  it("does not push when either Telegram var is unset", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_CHAT_ID", "");
    await monitor("unset_both");

    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:ABC");
    await monitor("unset_chat_id");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the Telegram sendMessage API with the chat id and event", async () => {
    enableTelegram();
    await monitor("db_query_failed_shape", { error: "connection refused" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe("42");
    expect(body.text).toContain("db_query_failed_shape");
    expect(body.text).toContain("connection refused");
  });

  it("truncates the message to Telegram's 4096-character limit", async () => {
    enableTelegram();
    await monitor("oversized", { error: "x".repeat(9000) });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.text.length).toBe(4096);
  });

  it("pushes the same event only once per throttle window", async () => {
    enableTelegram();
    for (let i = 0; i < 10; i += 1) await monitor("flooding");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throttles per event name, so a distinct failure still gets through", async () => {
    enableTelegram();
    await monitor("throttle_scope_a");
    await monitor("throttle_scope_a");
    await monitor("throttle_scope_b");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports the suppressed count on the next push that gets through", async () => {
    enableTelegram();
    vi.useFakeTimers();
    try {
      await monitor("suppressed_count");
      for (let i = 0; i < 4; i += 1) await monitor("suppressed_count");
      vi.advanceTimersByTime(61_000);
      await monitor("suppressed_count");
    } finally {
      vi.useRealTimers();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(
      (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.text).toContain("(+4 suppressed)");
  });

  it("still logs the events the throttle keeps out of Telegram", async () => {
    enableTelegram();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await monitor("throttled_still_logs");
    await monitor("throttled_still_logs");
    await monitor("throttled_still_logs");

    expect(warn).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed push so alerting never breaks the caller", async () => {
    enableTelegram();
    fetchMock.mockRejectedValueOnce(new Error("telegram down"));
    await expect(monitor("telegram_down")).resolves.toBeUndefined();
  });
});
