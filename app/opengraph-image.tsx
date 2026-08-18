import { ImageResponse } from "next/og";

/**
 * Social-preview card (§1.2, public beta launch): before this file existed,
 * there was no openGraph/twitter image anywhere, so every shared link
 * unfurled as bare text. Root-level file, so it's the fallback image for
 * every route — the library's address space is effectively infinite, so a
 * per-page image isn't worth generating; a shared address is still
 * distinguished by its title (generateMetadata, app/[[...address]]/page.tsx)
 * and URL alongside this one card.
 *
 * Deliberately no custom font loading: the intro animation's mono face
 * (`--font-intro-mono`, app/[[...address]]/intro-scene.tsx) is a CSS
 * variable next/font wires into the page — it isn't a font file this
 * Satori-based renderer can load without shipping the .ttf explicitly. The
 * built-in fallback keeps this simple and avoids being the thing that
 * breaks the Turbopack build (the actual risk in this file, per the plan).
 */
export const alt = "The Noumenon Library";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0a0c11";
const PAPER = "#efe9dc";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 28,
          background: INK,
          color: PAPER,
        }}
      >
        <div style={{ display: "flex", fontSize: 68, letterSpacing: 4 }}>
          THE NOUMENON LIBRARY
        </div>
        <div style={{ display: "flex", fontSize: 28, color: "rgba(239,233,220,0.6)" }}>
          every text that could ever be written already exists
        </div>
      </div>
    ),
    { ...size },
  );
}
