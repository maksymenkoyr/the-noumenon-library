import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono, Lora } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import { config } from "@/lib/config";
import { BetaBanner } from "./beta-banner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The reading face for the page itself — a book-like serif, distinct from
// the sans/mono used for the library's chrome. Both styles: the
// "crystallizing…"/placeholder copy (page-content.tsx) and the intro's
// narration (app/[[...address]]/intro-scene.tsx) set text in `italic`, which
// without this next/font renders as a browser-synthesized oblique rather
// than Lora's actual italic cut.
const lora = Lora({
  variable: "--font-serif",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

const DESCRIPTION =
  "An infinite library where every text that could ever be written already exists.";

// §1.2 (public beta launch): before this, there was no metadataBase/
// openGraph/twitter anywhere, so every shared link unfurled as bare text.
// metadataBase resolves the relative image URL from app/opengraph-image.tsx
// into an absolute one — required for a social unfurl to actually fetch it.
export const metadata: Metadata = {
  metadataBase: new URL(config.publicBaseUrl),
  title: "The Noumenon Library",
  description: DESCRIPTION,
  openGraph: {
    title: "The Noumenon Library",
    description: DESCRIPTION,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "The Noumenon Library",
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${lora.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <BetaBanner />
        {children}
        <footer className="mx-auto w-full max-w-2xl px-8 py-6 font-mono text-xs text-neutral-400">
          <p>
            Machine-generated fiction · non-commercial ·{" "}
            <Link
              href="/about"
              className="underline underline-offset-2 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              about &amp; reporting
            </Link>
          </p>
        </footer>
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}
