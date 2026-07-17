import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  getArrivalSignals,
  getModelSignals,
  getPageSignals,
  getVariantSignals,
  type ArrivalSignal,
  type ModelSignal,
  type PageSignal,
  type VariantSignal,
} from "@/lib/insights";
import { getOperatorMode } from "@/lib/operatorMode";
import { listOpenReports, type PageReport } from "@/lib/reports";
import { ResolveButton } from "./resolve-button";

// The operator-gated review surface (docs/reference/architecture.md §8, Phase 10):
// the open-report queue + the read-only insight rollups (lib/insights.ts,
// SQL views as source of truth). Same chrome as /about and /liked. Gated by
// the signed session cookie's operator claim (lib/operatorMode) — non-
// disclosure on failure: notFound() rather than a 401/403, so an uninvited
// visitor (or the gate being inert) sees an ordinary 404, not proof the
// route exists.

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Operator · The Noumenon Library",
  robots: { index: false, follow: false },
};

function age(date: Date): string {
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ms(value: number | null): string {
  return value === null ? "—" : `${(value / 1000).toFixed(1)}s`;
}

export default async function OperatorPage() {
  // Force request-time rendering: with no signing secret in the build
  // environment, getOperatorMode() returns false before ever touching
  // cookies(), and the page would prerender as a permanent static 404. The
  // claim check must run per request regardless of build-time env.
  await connection();
  if (!(await getOperatorMode())) notFound();

  const [reports, pageSignals, modelSignals, variantSignals, arrivalSignals] =
    await Promise.all([
      listOpenReports(),
      getPageSignals(100),
      getModelSignals(),
      getVariantSignals(),
      getArrivalSignals(),
    ]);

  return (
    <main className="mx-auto flex w-full max-w-4xl grow flex-col gap-8 p-8">
      <header className="flex items-baseline gap-4 font-mono text-sm text-neutral-500">
        <Link href="/" className="hover:text-neutral-900 dark:hover:text-neutral-100">
          ← the library
        </Link>
        <span>operator</span>
      </header>

      <ReportsQueue reports={reports} />
      <PageSignalsTable rows={pageSignals} />
      <ModelSignalsTable rows={modelSignals} />
      <VariantSignalsTable rows={variantSignals} />
      <ArrivalSignalsTable rows={arrivalSignals} />
    </main>
  );
}

function ReportsQueue({ reports }: { reports: PageReport[] }) {
  return (
    <section className="flex flex-col gap-3 font-mono text-sm text-neutral-500">
      <h1 className="text-neutral-800 dark:text-neutral-200">
        open reports ({reports.length})
      </h1>
      {reports.length === 0 ? (
        <p>no open reports.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {reports.map((r) => (
            <li key={r.id} className="flex items-baseline gap-4">
              <a
                href={`/${r.address}`}
                className="shrink-0 hover:text-neutral-900 dark:hover:text-neutral-100"
              >
                {r.address}
              </a>
              <span className="min-w-0 flex-1 truncate">{r.reason ?? "—"}</span>
              <span className="shrink-0">{age(r.createdAt)}</span>
              <ResolveButton id={r.id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PageSignalsTable({ rows }: { rows: PageSignal[] }) {
  return (
    <section className="flex flex-col gap-3 font-mono text-sm text-neutral-500">
      <h2 className="text-neutral-800 dark:text-neutral-200">
        page signals (top {rows.length})
      </h2>
      {rows.length === 0 ? (
        <p>no committed pages yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left">
            <thead>
              <tr className="text-neutral-400 dark:text-neutral-600">
                <th className="pr-4 font-normal">address</th>
                <th className="pr-4 font-normal">model</th>
                <th className="pr-4 font-normal">variant</th>
                <th className="pr-4 font-normal">likes</th>
                <th className="pr-4 font-normal">dislikes</th>
                <th className="pr-4 font-normal">reports</th>
                <th className="pr-4 font-normal">visits</th>
                <th className="pr-4 font-normal">avg dwell</th>
                <th className="font-normal">median dwell</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.address}>
                  <td className="pr-4">
                    <a
                      href={`/${p.address}`}
                      className="hover:text-neutral-900 dark:hover:text-neutral-100"
                    >
                      {p.address}
                    </a>
                  </td>
                  <td className="pr-4">{p.model ?? "—"}</td>
                  <td className="pr-4">{p.promptVariant ?? "—"}</td>
                  <td className="pr-4">{p.likes}</td>
                  <td className="pr-4">{p.dislikes}</td>
                  <td className="pr-4">{p.openReports}</td>
                  <td className="pr-4">{p.visits}</td>
                  <td className="pr-4">{ms(p.avgDwellMs)}</td>
                  <td>{ms(p.medianDwellMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ModelSignalsTable({ rows }: { rows: ModelSignal[] }) {
  return (
    <section className="flex flex-col gap-3 font-mono text-sm text-neutral-500">
      <h2 className="text-neutral-800 dark:text-neutral-200">model signals</h2>
      {rows.length === 0 ? (
        <p>no data yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left">
            <thead>
              <tr className="text-neutral-400 dark:text-neutral-600">
                <th className="pr-4 font-normal">model</th>
                <th className="pr-4 font-normal">pages</th>
                <th className="pr-4 font-normal">likes</th>
                <th className="pr-4 font-normal">dislikes</th>
                <th className="pr-4 font-normal">reports</th>
                <th className="pr-4 font-normal">visits</th>
                <th className="font-normal">avg median dwell</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.model ?? "—"}>
                  <td className="pr-4">{m.model ?? "—"}</td>
                  <td className="pr-4">{m.pages}</td>
                  <td className="pr-4">{m.likes}</td>
                  <td className="pr-4">{m.dislikes}</td>
                  <td className="pr-4">{m.openReports}</td>
                  <td className="pr-4">{m.visits}</td>
                  <td>{ms(m.avgMedianDwellMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function VariantSignalsTable({ rows }: { rows: VariantSignal[] }) {
  return (
    <section className="flex flex-col gap-3 font-mono text-sm text-neutral-500">
      <h2 className="text-neutral-800 dark:text-neutral-200">variant signals</h2>
      {rows.length === 0 ? (
        <p>no data yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left">
            <thead>
              <tr className="text-neutral-400 dark:text-neutral-600">
                <th className="pr-4 font-normal">variant</th>
                <th className="pr-4 font-normal">pages</th>
                <th className="pr-4 font-normal">likes</th>
                <th className="pr-4 font-normal">dislikes</th>
                <th className="pr-4 font-normal">reports</th>
                <th className="pr-4 font-normal">visits</th>
                <th className="font-normal">avg median dwell</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.promptVariant ?? "—"}>
                  <td className="pr-4">{v.promptVariant ?? "—"}</td>
                  <td className="pr-4">{v.pages}</td>
                  <td className="pr-4">{v.likes}</td>
                  <td className="pr-4">{v.dislikes}</td>
                  <td className="pr-4">{v.openReports}</td>
                  <td className="pr-4">{v.visits}</td>
                  <td>{ms(v.avgMedianDwellMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ArrivalSignalsTable({ rows }: { rows: ArrivalSignal[] }) {
  return (
    <section className="flex flex-col gap-3 font-mono text-sm text-neutral-500">
      <h2 className="text-neutral-800 dark:text-neutral-200">arrival signals</h2>
      {rows.length === 0 ? (
        <p>no dwell beacons yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left">
            <thead>
              <tr className="text-neutral-400 dark:text-neutral-600">
                <th className="pr-4 font-normal">arrived via</th>
                <th className="pr-4 font-normal">visits</th>
                <th className="pr-4 font-normal">avg dwell</th>
                <th className="font-normal">median dwell</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.arrivedVia ?? "—"}>
                  <td className="pr-4">{a.arrivedVia ?? "unknown"}</td>
                  <td className="pr-4">{a.visits}</td>
                  <td className="pr-4">{ms(a.avgDwellMs)}</td>
                  <td>{ms(a.medianDwellMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
