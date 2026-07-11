"use client";

import { useEffect, useState } from "react";
import { parsePressedEntry, type PressedEntry } from "@/lib/pressed";

/**
 * The pressed leaves kept in this browser (lib/pressed.ts convention), newest
 * press first. Read once on mount — the page is reached by a full page load
 * (nav ethos), so there is no live state to subscribe to. `null` until the
 * effect runs, keeping the server render and hydration blank.
 */

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

export function LikedList() {
  const [entries, setEntries] = useState<PressedEntry[] | null>(null);

  useEffect(() => {
    setEntries(readPressedEntries());
  }, []);

  if (entries === null) return null;

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
