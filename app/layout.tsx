import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono, Lora } from "next/font/google";
import { INTRO_SEEN_ATTR, INTRO_SEEN_KEY } from "@/lib/introSeen";
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
// the sans/mono used for the library's chrome.
const lora = Lora({
  variable: "--font-serif",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "The Noumenon Library",
  description:
    "An infinite library where every text that could ever be written already exists.",
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
      <head>
        {/* Blocking, runs before hydration ("preventing flash before
            hydration", node_modules/next/dist/docs/01-app/02-guides/): stamps
            INTRO_SEEN_ATTR onto <html> for anyone who's already seen the
            first-visit intro (lib/introSeen.ts), so a returning visitor's
            full-page-load navigation never flashes the overlay on and off —
            globals.css hides it whenever the attribute is present. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem(${JSON.stringify(INTRO_SEEN_KEY)}))document.documentElement.setAttribute(${JSON.stringify(INTRO_SEEN_ATTR)},"1")}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
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
      </body>
    </html>
  );
}
