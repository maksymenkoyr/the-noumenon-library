// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Marks } from "./marks";

/**
 * The two behaviours that client-side wandering (nav.tsx) put at risk. Both fail
 * *silently* — they degrade the research log rather than throwing — so they are
 * pinned here rather than left to a manual devtools pass.
 *
 *  1. `arrived_via` is claimed per navigation, not per document. Under
 *     client-side nav this module is evaluated once and then serves every page,
 *     so a claim that ran at module scope would report a breadcrumb for the
 *     first page only.
 *  2. `leave` is emitted exactly once per load, whether the load ends by
 *     `pagehide` (tab close, full page load) or by effect cleanup (a client-side
 *     navigation, where `pagehide` never fires).
 */

const ARRIVED_KEY = "noumenon:arrived-via";

type Beacon = {
  loadId: string;
  address: string;
  events: { e: string; t: number; seq: number; via?: string }[];
};

let beacons: Beacon[] = [];
let container: HTMLDivElement;
let root: Root;

/** Every event this load beaconed, in sequence order. */
function eventsFor(address: string) {
  return beacons
    .filter((b) => b.address === address)
    .flatMap((b) => b.events)
    .sort((a, b) => a.seq - b.seq);
}

function mount(address: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Marks address={address} initialCount={0} />);
  });
}

/** A client-side navigation away: React unmounts, `pagehide` does not fire. */
function unmount() {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/** One whole visit to a page, arriving with `via` in the breadcrumb slot. */
function visit(address: string, via?: string) {
  if (via) sessionStorage.setItem(ARRIVED_KEY, via);
  mount(address);
  unmount();
  return eventsFor(address);
}

beforeEach(() => {
  beacons = [];
  sessionStorage.clear();
  localStorage.clear();
  // jsdom implements neither, and `fetch` here would be the like/dislike writes.
  vi.stubGlobal("navigator", {
    ...window.navigator,
    sendBeacon: (_url: string, body: string) => {
      beacons.push(JSON.parse(body));
      return true;
    },
  });
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  // React 19 requires this for `act` outside a test renderer.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("arrived_via breadcrumb", () => {
  it("is claimed on every page, not just the first of the document", () => {
    // The regression: with a module-scope claim, the second page reports nothing
    // because the module was already evaluated and the key already cleared.
    const first = visit("1/1/1/1/1", "next");
    const second = visit("1/1/1/1/2", "next");

    expect(first.find((e) => e.e === "arrive")?.via).toBe("next");
    expect(second.find((e) => e.e === "arrive")?.via).toBe("next");
  });

  it("consumes the breadcrumb exactly once", () => {
    visit("2/1/1/1/1", "random");
    // No breadcrumb written for this hop (e.g. browser Back): it must not
    // inherit the previous page's.
    const inherited = visit("2/1/1/1/2");

    expect(inherited.find((e) => e.e === "arrive")?.via).toBeUndefined();
    expect(sessionStorage.getItem(ARRIVED_KEY)).toBeNull();
  });

  it("reports nothing on a fresh tab (direct URL, shared link)", () => {
    const events = visit("3/1/1/1/1");
    expect(events.find((e) => e.e === "arrive")?.via).toBeUndefined();
  });

  it("reuses the claim when the same address remounts (StrictMode)", () => {
    // A dev double-mount re-runs the effect against an already-cleared key; the
    // claim must survive it rather than degrade to null.
    sessionStorage.setItem(ARRIVED_KEY, "typed");
    mount("4/1/1/1/1");
    unmount();
    mount("4/1/1/1/1");
    unmount();

    const arrivals = eventsFor("4/1/1/1/1").filter((e) => e.e === "arrive");
    expect(arrivals).toHaveLength(2);
    expect(arrivals.every((e) => e.via === "typed")).toBe(true);
  });

  it("re-reads for a revisited address once another page has intervened", () => {
    // A -> B -> A: the memo is a single slot, so B displaces A's claim and the
    // second A must go back to sessionStorage (and find nothing).
    visit("5/1/1/1/1", "random");
    visit("5/1/1/1/2", "next");
    mount("5/1/1/1/1");
    unmount();

    const arrivals = eventsFor("5/1/1/1/1").filter((e) => e.e === "arrive");
    expect(arrivals[0].via).toBe("random");
    expect(arrivals[1].via).toBeUndefined();
  });
});

describe("leave event", () => {
  it("is emitted when a client-side navigation unmounts the page", () => {
    // The regression: `pagehide` does not fire on a client-side route change, so
    // without the cleanup path this load would never close or flush.
    const events = visit("6/1/1/1/1", "next");
    expect(events.filter((e) => e.e === "leave")).toHaveLength(1);
  });

  it("is emitted once when pagehide fires and cleanup also runs", () => {
    mount("7/1/1/1/1");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    unmount();

    expect(eventsFor("7/1/1/1/1").filter((e) => e.e === "leave")).toHaveLength(1);
  });

  it("closes each load exactly once across a multi-page wander", () => {
    const addresses = ["8/1/1/1/1", "8/1/1/1/2", "8/1/1/1/3"];
    for (const address of addresses) visit(address, "next");

    for (const address of addresses) {
      expect(eventsFor(address).filter((e) => e.e === "leave")).toHaveLength(1);
    }
    // One load id per page — no correlation across the wander.
    expect(new Set(beacons.map((b) => b.loadId)).size).toBe(addresses.length);
  });

  it("closes again after a bfcache restore", () => {
    mount("9/1/1/1/1");
    act(() => {
      window.dispatchEvent(new Event("pagehide")); // into bfcache: leave #1
    });
    act(() => {
      // Restored: `visibilitychange` -> visible re-arms the load.
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    unmount(); // a real second departure: leave #2

    const events = eventsFor("9/1/1/1/1");
    expect(events.filter((e) => e.e === "leave")).toHaveLength(2);
    // ...and the restore is recorded between them, not swallowed.
    const order = events.map((e) => e.e);
    expect(order.lastIndexOf("visible")).toBeGreaterThan(order.indexOf("leave"));
  });

  it("beacons the arrive event, so a page with no interaction still reports", () => {
    const events = visit("10/1/1/1/1", "random");
    expect(events.map((e) => e.e)).toEqual(["arrive", "visible", "leave"]);
  });
});
