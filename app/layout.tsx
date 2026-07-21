import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono, Lora } from "next/font/google";
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
