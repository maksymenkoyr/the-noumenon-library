import { ImageResponse } from "next/og";

/**
 * The link-preview card. At the app root, so it is the image for every
 * route: the address space is effectively infinite, so a shared address is
 * told apart by its title (generateMetadata in app/[[...address]]/page.tsx)
 * rather than by a card of its own.
 *
 * Built-in font only: the site's faces come from next/font as CSS variables,
 * which this renderer cannot read without shipping the font files to it.
 */
export const alt = "The Noumenon Library";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0a0c11";
const PAPER = "#efe9dc";
const FADED_PAPER = "rgba(239,233,220,0.6)";

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
        <div style={{ display: "flex", fontSize: 28, color: FADED_PAPER }}>
          every text that could ever be written already exists
        </div>
      </div>
    ),
    { ...size },
  );
}
