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
import { getDevMode } from "@/lib/devMode";
import { resolvePage, type ResolvedPage } from "@/lib/resolvePage";
import { getPage } from "@/lib/store";
import { DevBadge } from "./dev-badge";
import { CrystallizingLeaf, Leaf, PlaceholderLeaf } from "./leaf";
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

  // Dev overlay gate (lib/devMode): the badge is only rendered when this visitor
  // holds the grant, so non-dev traffic sees no change.
  const devMode = await getDevMode();

  return (
    <main className="mx-auto flex w-full max-w-2xl grow flex-col gap-8 p-8">
      <header className="flex items-baseline gap-4 font-mono text-sm text-neutral-500">
        <span className="shrink-0">{canonical}</span>
        <Nav nextHref={nextHref} />
      </header>
      {existing?.status === "ok" ? (
        <>
          <Leaf>{existing.content ?? ""}</Leaf>
          {devMode && <DevBadge model={existing.model} />}
        </>
      ) : existing?.status === "taken_down" ? (
        <PlaceholderLeaf variant="taken_down" />
      ) : (
        <Suspense fallback={<CrystallizingLeaf />}>
          <PageBody address={canonical} devMode={devMode} />
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
async function PageBody({
  address,
  devMode,
}: {
  address: string;
  devMode: boolean;
}) {
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
  if (resolved.status === "ok")
    return (
      <>
        <Leaf>{resolved.text}</Leaf>
        {devMode && (
          <DevBadge model={resolved.model} durationMs={resolved.durationMs} />
        )}
      </>
    );
  // taken_down can surface here if a takedown lands while we waited.
  return <PlaceholderLeaf variant="taken_down" />;
}
