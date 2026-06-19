import { notFound, redirect } from "next/navigation";
import {
  addressPath,
  formatAddress,
  nextAddress,
  normalizeAddress,
  randomAddress,
} from "@/lib/address";
import { resolvePage } from "@/lib/resolvePage";

export const runtime = "nodejs";

export default async function Page({
  params,
}: {
  params: Promise<{ address?: string[] }>;
}) {
  const { address: segments } = await params;
  // The bare root is the random entry into the library.
  if (!segments) redirect(addressPath(randomAddress()));

  const address = normalizeAddress(segments);
  if (!address) notFound();

  const canonical = formatAddress(address);
  const { status, text } = await resolvePage(canonical);

  return (
    <main className="mx-auto flex w-full max-w-2xl grow flex-col gap-8 p-8">
      <header className="flex items-baseline justify-between gap-4 font-mono text-sm text-neutral-500">
        <span>{canonical}</span>
        {/* Plain anchors: "random" must re-resolve server-side on every
            click, which Link prefetching/caching would defeat. */}
        <nav className="flex gap-4">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" className="hover:text-neutral-900">
            random
          </a>
          <a
            href={addressPath(nextAddress(address))}
            className="hover:text-neutral-900"
          >
            next →
          </a>
        </nav>
      </header>
      {status === "ok" ? (
        <p className="whitespace-pre-wrap">{text}</p>
      ) : (
        // Placeholder for taken_down; full styling is Phase 5.
        <p className="italic text-neutral-400">{text}</p>
      )}
    </main>
  );
}
