import type { Metadata } from "next";

/**
 * The title, description and social tags every route shares. A route that
 * sets its own `openGraph` replaces the layout's whole object rather than
 * merging into it, so a per-page title has to restate the rest — hence one
 * builder for app/layout.tsx and app/[[...address]]/page.tsx.
 */
export const SITE_TITLE = "The Noumenon Library";
export const SITE_DESCRIPTION =
  "An infinite library where every text that could ever be written already exists.";

export function socialMetadata(title: string = SITE_TITLE): Metadata {
  return {
    title,
    description: SITE_DESCRIPTION,
    openGraph: {
      title,
      description: SITE_DESCRIPTION,
      siteName: SITE_TITLE,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: SITE_DESCRIPTION,
    },
  };
}
