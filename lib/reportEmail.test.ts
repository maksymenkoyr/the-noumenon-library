import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendReportEmail } from "./reportEmail";

const REPORT = { address: "io-9/3/2/17/308", reason: "looks broken" };

describe("sendReportEmail", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does nothing when the Resend key or recipient is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("REPORT_NOTIFY_EMAIL", "");
    await sendReportEmail(REPORT);

    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    await sendReportEmail(REPORT);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to Resend with the key, recipient, and address", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("REPORT_NOTIFY_EMAIL", "operator@example.com");
    await sendReportEmail(REPORT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer re_test_key",
    );
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["operator@example.com"]);
    expect(body.subject).toContain(REPORT.address);
    expect(body.text).toContain("looks broken");
  });

  it("notes a missing reason rather than omitting the line", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("REPORT_NOTIFY_EMAIL", "operator@example.com");
    await sendReportEmail({ address: REPORT.address, reason: null });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.text).toContain("(none given)");
  });

  it("swallows a failed send (fail-open)", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("REPORT_NOTIFY_EMAIL", "operator@example.com");
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(sendReportEmail(REPORT)).resolves.toBeUndefined();
  });
});
