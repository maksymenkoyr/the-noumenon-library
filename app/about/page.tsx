import type { Metadata } from "next";
import Link from "next/link";
import { config } from "@/lib/config";

// Static launch-hardening page (Phase 9): the legal disclaimer, non-commercial
// notice, license/source, privacy posture, and the abuse/copyright report path
// (docs/legal.md). No data fetch — this route prerenders. It also shadows the
// `[[...address]]` optional catch-all for `/about` (static routes take priority).

export const metadata: Metadata = {
  title: "About · The Noumenon Library",
  description:
    "Machine-generated fiction. A non-commercial art project. How to report content.",
};

const SOURCE_URL = "https://github.com/maksymenkoyr/the-noumenon-library";

export default function AboutPage() {
  const email = config.reportContactEmail;

  return (
    <main className="mx-auto flex w-full max-w-2xl grow flex-col gap-8 p-8">
      <header className="flex items-baseline gap-4 font-mono text-sm text-neutral-500">
        <Link
          href="/"
          className="hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← the library
        </Link>
        <span>about</span>
      </header>

      <div className="flex flex-col gap-8 text-neutral-800 dark:text-neutral-200">
        <section className="flex flex-col gap-3">
          <h1 className="text-lg font-medium">About this library</h1>
          <p>
            The Noumenon Library is an endless, shared library of pages that do
            not exist until someone walks into them. Every page is{" "}
            <strong>machine-generated fiction</strong> — produced by a language
            model the first time its address is visited, then kept. No page is
            written or reviewed by a person. Nothing here is a statement of
            fact, and any resemblance to real texts, events, or people is
            coincidental.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-medium">Non-commercial</h2>
          <p>
            This is a non-commercial art project. There are no ads, no accounts,
            and nothing is for sale. It is free to wander.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-medium">Privacy</h2>
          <p>
            No accounts, and no personal data is collected to read. If you press
            a leaf, that mark is remembered only in your own browser; the
            library keeps just an anonymous count per page, never tied to you.
            For rate limiting only, a visitor&apos;s IP address is hashed (never
            stored in the clear) and the hash is discarded shortly after — see
            the{" "}
            <a
              href={`${SOURCE_URL}/blob/main/docs/legal.md`}
              className="underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
            >
              legal &amp; safety notes
            </a>
            . The project operates under EU/Polish law (GDPR, DSA).
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-medium">License &amp; source</h2>
          <p>
            Released under the{" "}
            <strong>GNU Affero General Public License v3</strong>. The source is
            public:{" "}
            <a
              href={SOURCE_URL}
              className="underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
            >
              {SOURCE_URL.replace("https://", "")}
            </a>
            .
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-medium">Reporting content</h2>
          <p>
            To report content — a copyright concern, or anything illegal — use
            the <strong>report</strong> control at the bottom of the page
            itself, or note the <strong>address</strong> shown at the top (for
            example <code className="font-mono text-sm">io-9/3/2/17/308</code>)
            and email it to us. Reported addresses are reviewed and, when
            warranted, removed: the page is blanked and never regenerates.
          </p>
          {email ? (
            <p>
              Email:{" "}
              <a
                href={`mailto:${email}?subject=Noumenon%20Library%20report`}
                className="underline underline-offset-2"
              >
                {email}
              </a>
            </p>
          ) : (
            <p className="text-neutral-500">
              Reporting contact is temporarily unavailable.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
