// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Report } from "./report";

/**
 * The regression this pins: the control used to call `writeReported` *before*
 * the fetch resolved, so a rejected report (access gate, throttle, bad
 * address) rendered the same "reported — thank you" as a real one, and
 * because the ack latches in localStorage forever, the reader could never
 * tell and could never retry from that browser. `submit` must only latch on
 * a genuine `{ok:true}`.
 */

let container: HTMLDivElement;
let root: Root;

function mount(address: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Report address={address} contactEmail="ops@example.com" />);
  });
}

function unmount() {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function openForm() {
  const button = container.querySelector("button") as HTMLButtonElement;
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function submitForm() {
  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    // Flush the fetch promise chain.
    await Promise.resolve();
    await Promise.resolve();
  });
}

const reportedKey = (address: string) => `noumenon:reported:${address}`;

beforeEach(() => {
  localStorage.clear();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Report", () => {
  it("marks reported and persists to localStorage on a real success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    mount("1/1/1/1/1");
    openForm();
    await submitForm();

    expect(container.textContent).toContain("reported — thank you");
    expect(localStorage.getItem(reportedKey("1/1/1/1/1"))).not.toBeNull();
    unmount();
  });

  it("does not mark reported on an access-gate 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gated", { status: 401 })),
    );
    mount("2/1/1/1/1");
    openForm();
    await submitForm();

    expect(container.textContent).not.toContain("reported — thank you");
    expect(container.querySelector("form")).not.toBeNull();
    expect(localStorage.getItem(reportedKey("2/1/1/1/1"))).toBeNull();
    unmount();
  });

  it("does not mark reported on a throttled 200 ({ok:false})", async () => {
    // app/api/report/route.ts: admitEngagementWrite failing returns a plain
    // 200 with ok:false — status alone can't distinguish this from success.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
      ),
    );
    mount("3/1/1/1/1");
    openForm();
    await submitForm();

    expect(container.textContent).not.toContain("reported — thank you");
    expect(localStorage.getItem(reportedKey("3/1/1/1/1"))).toBeNull();
    unmount();
  });

  it("does not mark reported when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    mount("4/1/1/1/1");
    openForm();
    await submitForm();

    expect(container.textContent).not.toContain("reported — thank you");
    expect(localStorage.getItem(reportedKey("4/1/1/1/1"))).toBeNull();
    unmount();
  });

  it("renders the acknowledged state without fetching for an already-reported address", () => {
    localStorage.setItem(reportedKey("5/1/1/1/1"), String(Date.now()));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mount("5/1/1/1/1");

    expect(container.textContent).toContain("reported — thank you");
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
  });
});
