import type { Metadata } from "next";
import Link from "next/link";
import { LikedList } from "./liked-list";

// The reader's own liked pages. Per-reader state lives entirely in
// localStorage (no accounts — docs/reference/legal.md), so the listing is a client
// component and this shell prerenders. Like /about, this static route shadows
// the `[[...address]]` catch-all (static routes take priority; addresses are
// always five segments, so nothing is masked).

export const metadata: Metadata = {
  title: "Liked pages · The Noumenon Library",
  description: "The pages this browser has liked.",
};

export default function LikedPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl grow flex-col gap-8 p-8">
      <header className="flex items-baseline gap-4 font-mono text-sm text-neutral-500">
        <Link href="/" className="hover:text-neutral-900 dark:hover:text-neutral-100">
          ← the library
        </Link>
        <span>liked pages</span>
      </header>

      <LikedList />
    </main>
  );
}
