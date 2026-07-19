// Success-bar eval harness (Phase 9, docs/experience.md "Success bar",
// docs/generation.md "coherent but hollow"). Walks N random addresses through
// the running app and writes a scorable Markdown sample for a manual read.
//
// This GENERATES real pages (each random address crystallizes and is stored) and
// spends generation tokens — run it against a dev server, deliberately.
//
// Usage: npm run dev  (in another terminal), then:
//        npm run wander -- 20
//        BASE=https://example.com npm run wander -- 20
import { writeFile } from "node:fs/promises";

const count = Number(process.argv[2] ?? 20);
if (!Number.isInteger(count) || count <= 0) {
  console.error("Usage: npm run wander -- <count>   (positive integer)");
  process.exit(1);
}
const base = (process.env.BASE ?? "http://localhost:3000").replace(/\/$/, "");

/** Resolve one random address via the app's own generator endpoint. */
async function walk() {
  const res = await fetch(`${base}/api/generate`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${base}/api/generate → ${res.status}`);
  return res.json(); // { address, status, text, model, generationMs, moderationMs, moderationModel, prompt }
}

/** Render the provenance line for one page — degrades gracefully for a
 * revisit (model only) or an unmoderated/disabled chain (no moderation model). */
function provenanceLine({ model, generationMs, moderationMs, moderationModel }) {
  if (!model) return null;
  const gen =
    generationMs != null ? `${model} (${(generationMs / 1000).toFixed(1)}s)` : model;
  const mod =
    moderationModel != null
      ? `${moderationModel}${moderationMs != null ? ` (${(moderationMs / 1000).toFixed(1)}s)` : ""}`
      : "—";
  return `model: ${gen} · moderation: ${mod}`;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outfile = `wander-${stamp}.md`;

const lines = [
  `# Wander sample — ${count} pages`,
  "",
  `Generated ${new Date().toISOString()} from ${base}`,
  "",
  "## How to score",
  "",
  "The bar (docs/experience.md): a **meaningful fraction** of a 20-page wander",
  "should produce a *pause* — a page you find yourself reading again, not sure",
  "why. Not every page; not most. The failure mode (docs/generation.md) is",
  "**coherent but hollow**: readable, forgettable, empty.",
  "",
  "For each page below, mark `[pause]`, `[hollow]`, or `[ ]`. Tally at the end.",
  "",
  "---",
  "",
];

for (let i = 1; i <= count; i++) {
  process.stdout.write(`\rwalking ${i}/${count}…`);
  try {
    const result = await walk();
    const { address, status, text, prompt } = result;
    const provenance = provenanceLine(result);
    const block = [
      `# \`${address}\`  — status: ${status}`,
      "",
      ...(provenance ? [provenance, ""] : []),
      "score: `[ ]`  (pause / hollow / blank)",
      "",
      ...(status === "ok" ? text.split("\n") : [`_(${status} — no page)_`]),
      "",
      ...(prompt
        ? ["<details>", "<summary>prompt</summary>", "", "```", ...prompt.split("\n"), "```", "", "</details>", ""]
        : []),
    ];
    lines.push(
      ...block.map((line, idx) => (idx === 0 ? `${i}. ${line}` : line === "" ? "" : `   ${line}`)),
      "",
    );
  } catch (error) {
    lines.push(`${i}. # — error`, "", `   \`${String(error)}\``, "", "");
  }
}
process.stdout.write("\n");

lines.push(
  "## Tally",
  "",
  "- pauses: __ / " + count,
  "- hollow: __",
  "- verdict (meaningful fraction paused?): __",
  "",
);

await writeFile(outfile, lines.join("\n"), "utf8");
console.log(`Wrote ${outfile}`);
