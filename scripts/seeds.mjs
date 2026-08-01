// Inspect the gallery association seeds (lib/gallerySeeds.ts) — the term lists
// each gallery token was expanded into, and which volumes drew what.
//
// The lists are the input to every page in a gallery, and their quality varies
// a lot by token (evocative and nonsense tokens expand richly; strongly
// denotative ones like `bmw89` clump inside their own domain). Reading them is
// how you tell whether a gallery is worth anything, so it should not require a
// database client.
//
// Read-only: this never calls a model and never writes. A gallery's terms are
// minted by the first page generated inside it.
//
// Usage: npm run seeds              — every gallery, newest first
//        npm run seeds bmw89        — one gallery's full term list
//        npm run seeds bmw89 --volumes — which term each volume of it drew
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const args = process.argv.slice(2);
const gallery = args.find((a) => !a.startsWith("--"));
const showVolumes = args.includes("--volumes");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  if (!gallery) {
    const { rows } = await client.query(
      `SELECT gallery, jsonb_array_length(terms) AS n, model, created_at
       FROM gallery_seeds ORDER BY created_at DESC`,
    );
    if (rows.length === 0) {
      console.log(
        "No galleries seeded yet — a gallery's terms are minted by the first\n" +
          "page generated inside it. Visit a novel address and look again.",
      );
    } else {
      for (const r of rows) {
        console.log(
          `${r.gallery.padEnd(14)} ${String(r.n).padStart(3)} terms  ` +
            `${r.created_at.toISOString().slice(0, 16)}  ${r.model ?? "?"}`,
        );
      }
      console.log(`\n${rows.length} galleries. Pass one as an argument to read it.`);
    }
  } else {
    const { rows } = await client.query(
      "SELECT terms, model, created_at FROM gallery_seeds WHERE gallery = $1",
      [gallery],
    );
    if (rows.length === 0) {
      console.log(`No terms stored for "${gallery}".`);
    } else {
      const { terms, model, created_at } = rows[0];
      console.log(
        `${gallery} — ${terms.length} terms, ${model ?? "?"}, ` +
          `${created_at.toISOString().slice(0, 16)}\n`,
      );
      console.log(terms.map((t, i) => `${String(i + 1).padStart(3)}. ${t}`).join("\n"));

      if (showVolumes) {
        // Which term each *page* actually landed on, read back from provenance
        // rather than recomputed — pages.seed_word is written at commit.
        const { rows: used } = await client.query(
          `SELECT seed_word, count(*)::int AS pages,
                  min(address) AS example
           FROM pages
           WHERE address LIKE $1 AND seed_word IS NOT NULL
           GROUP BY seed_word ORDER BY pages DESC`,
          [`${gallery}/%`],
        );
        console.log(`\n--- terms actually in use (${used.length}) ---`);
        for (const u of used) {
          console.log(`${u.seed_word.padEnd(28)} ${u.pages} page(s)  e.g. ${u.example}`);
        }
        if (used.length === 0) {
          console.log("none yet — no page in this gallery has been committed with a seed");
        }
      }
    }
  }
} finally {
  await client.end();
}
