import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import {
  addressPath,
  formatAddress,
  nextAddress,
  normalizeAddress,
  randomAddress,
} from "@/lib/address";
import { getClientIp } from "@/lib/clientIp";
import { getLikeCount } from "@/lib/engagement";
import { resolvePage, type ResolvedPage } from "@/lib/resolvePage";
import { getPage } from "@/lib/store";
import { CrystallizingLeaf, Leaf, PlaceholderLeaf } from "./leaf";
import { Marks } from "./marks";
import { Nav } from "./nav";

export const runtime = "nodejs";
export const maxDuration = 60; // Hobby cap; generations run 8–32s

export default async function Page({
  params,
}: {
  params: Promise<{ address?: string[] }>;
}) {
  const { address: segments } = await params;
  // The bare root is the random entry into the library.
  if (!segments) redirect(addressPath(randomAddress()));

  const address = normalizeAddress(segments);
  // notFound() must fire before any Suspense boundary so an invalid address gets
  // a real 404, not a 200 with noindex (Next streaming guide, "The HTTP contract").
  if (!address) notFound();

  const canonical = formatAddress(address);
  const nextHref = addressPath(nextAddress(address));

  // One fast lookup decides the shape of the response. A committed page renders
  // synchronously (instant revisits, no fallback flash); only a first visit (or
  // an in-flight one by another visitor) suspends behind the crystallizing leaf.
  const existing = await getPage(canonical);

  return (
    <main className="mx-auto flex w-full max-w-2xl grow flex-col gap-8 p-8">
      <header className="flex items-baseline gap-4 font-mono text-sm text-neutral-500">
        <span className="shrink-0">{canonical}</span>
        <Nav nextHref={nextHref} />
      </header>
      {existing?.status === "ok" ? (
        <CommittedLeaf address={canonical} text={existing.content ?? ""} />
      ) : existing?.status === "taken_down" ? (
        <PlaceholderLeaf variant="taken_down" />
      ) : (
        <Suspense fallback={<CrystallizingLeaf />}>
          <PageBody address={canonical} />
        </Suspense>
      )}
    </main>
  );
}

/**
 * The slow path: crystallize (or wait for) a never-seen page, behind a Suspense
 * boundary so the shell above paints immediately. Only this path reads the
 * client IP (for the rate limit) and touches admission control — cache hits
 * render synchronously above and stay free. resolvePage throws on a
 * generation/moderation failure or wait timeout (it releases the reservation
 * first, so nothing is persisted) and returns `explore` when admission control
 * refuses generation (spend cap / rate limit) — both render explore-only rather
 * than an error page. The address simply stays dark until a later visit.
 */
async function PageBody({ address }: { address: string }) {
  // Resolve to a plain value first; keep JSX construction out of the try/catch
  // (render errors wouldn't be caught there anyway — react-hooks/error-boundaries).
  let resolved: ResolvedPage | "explore";
  try {
    resolved = await resolvePage(address, { clientIp: await getClientIp() });
  } catch {
    resolved = "explore";
  }

  if (resolved === "explore" || resolved.status === "explore") {
    return <PlaceholderLeaf variant="explore" />;
  }
  if (resolved.status === "ok") {
    return <CommittedLeaf address={address} text={resolved.text} />;
  }
  // taken_down can surface here if a takedown lands while we waited.
  return <PlaceholderLeaf variant="taken_down" />;
}

/**
 * A committed leaf and its reader marks (press count + dwell timer). The like
 * count is a fast indexed lookup fetched here so it's co-located with the `ok`
 * state — on the synchronous path it just adds one quick query to the render; on
 * the streamed path it resolves inside the existing Suspense boundary.
 */
async function CommittedLeaf({
  address,
  text,
}: {
  address: string;
  text: string;
}) {
  const likeCount = await getLikeCount(address);
  return (
    <>
      <Leaf>{text}</Leaf>
      <Marks address={address} initialCount={likeCount} />
    </>
  );
}
