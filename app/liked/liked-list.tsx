"use client";

import { useSyncExternalStore } from "react";
import { parsePressedEntry, PRESS_EVENT, type PressedEntry } from "@/lib/pressed";

/**
 * The pressed leaves kept in this browser (lib/pressed.ts convention), newest
 * press first. Same useSyncExternalStore idiom as the leaf marks: the server
 * snapshot is a stable `null` (this listing is localStorage-only, so the
 * server and hydration renders are blank), and the client snapshot is cached
 * between storage events so it stays referentially stable.
 */

let cache: PressedEntry[] | null = null;

function readPressedEntries(): PressedEntry[] {
  const entries: PressedEntry[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null) continue;
      const entry = parsePressedEntry(key, localStorage.getItem(key));
      if (entry) entries.push(entry);
    }
  } catch {
    /* localStorage disabled (private mode) — nothing was ever kept */
  }
  return entries.sort((a, b) => b.pressedAt - a.pressedAt);
}

function getSnapshot(): PressedEntry[] {
  if (cache === null) cache = readPressedEntries();
  return cache;
}

function subscribe(onChange: () => void): () => void {
  const invalidate = () => {
    cache = null;
    onChange();
  };
  window.addEventListener(PRESS_EVENT, invalidate);
  window.addEventListener("storage", invalidate);
  return () => {
    window.removeEventListener(PRESS_EVENT, invalidate);
    window.removeEventListener("storage", invalidate);
  };
}

export function LikedList() {
  const entries = useSyncExternalStore(subscribe, getSnapshot, () => null);

  if (entries === null) return null; // server render / hydrating

  if (entries.length === 0) {
    return (
      <p className="font-mono text-sm text-neutral-500">
        no pressed leaves yet — wander, and press one to keep it.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2 font-mono text-sm text-neutral-500">
      {entries.map(({ address }) => (
        <li key={address}>
          <a
            href={`/${address}`}
            className="hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ♥ {address}
          </a>
        </li>
      ))}
    </ul>
  );
}
