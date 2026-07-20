import { describe, expect, it } from "vitest";
import { deviceClass } from "./device";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const ANDROID_MOBILE =
  "Mozilla/5.0 (Linux; Android 14; SM-G991U) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X510) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DESKTOP_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DESKTOP_FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0";

describe("deviceClass", () => {
  it.each([
    ["iPhone Safari", IPHONE, "mobile"],
    ["Android phone Chrome", ANDROID_MOBILE, "mobile"],
    ["iPad Safari", IPAD, "tablet"],
    ["Android tablet Chrome", ANDROID_TABLET, "tablet"],
    ["desktop Chrome", DESKTOP_CHROME, "desktop"],
    ["desktop Firefox", DESKTOP_FIREFOX, "desktop"],
  ] as const)("%s -> %s", (_label, ua, expected) => {
    expect(deviceClass(ua)).toBe(expected);
  });

  it("returns null for null, undefined, and empty UA", () => {
    expect(deviceClass(null)).toBeNull();
    expect(deviceClass(undefined)).toBeNull();
    expect(deviceClass("")).toBeNull();
  });
});
