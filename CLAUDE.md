@AGENTS.md

## Documentation Standards

All project documentation lives in the `docs/` directory, which is **also an
Obsidian vault** (`docs/.obsidian/`). Obsidian resolves standard Markdown links
and shows them in its graph, so standard links give us both worlds — navigable
in Obsidian **and** rendered correctly on GitHub. Link guidance:

1. **Prefer standard, relative Markdown links** (e.g., `[Overview](./overview.md)`)
   for docs meant to be read on GitHub — they render there _and_ resolve in
   Obsidian, so they are the safe default and what the published docs use today.
2. **Wikilinks (`[[Overview]]`) are acceptable** where you are working
   Obsidian-first and leaning on the graph — just know they don't render on
   GitHub, and when refactoring you must resolve **both** directions: the forward
   link (`[[X]]`) _and_ its backlinks. Grep for both when renaming a note.

(Note: `app/[[...address]]/…` in the docs is a Next.js catch-all route path, not a wikilink.)
