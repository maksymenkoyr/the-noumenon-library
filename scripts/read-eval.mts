// Reading-simulation eval harness (docs/reference/experience.md "Success
// bar", docs/backlog.md "AI evaluation of the success bar"). Unlike
// scripts/wander-sample.mjs (which generates fresh pages and leaves scoring
// to a human), this reads EXISTING stored pages through a staged,
// context-bounded reading protocol (lib/reading/*) — so "did this pause a
// reader" is answered by something that only ever sees what a reader would
// have seen at each moment, never the whole page with perfect foresight.
//
// This SPENDS real money (a strong reader model, ~6 calls/page) and does NOT
// pass through monthly_spend — it prints a cost estimate before running.
//
// Usage: npm run db:migrate   (once, to seed model_registry task='reader' rows)
//        npm run read-eval -- 20
//        npm run read-eval -- 20 --seed 7 --viewport mobile
//        npm run read-eval -- --address io-9/3/2/17/308
//        npm run read-eval -- 20 --variant 'base-v1+no-library%' --model z-ai/glm-5.2
//        npm run read-eval -- --calibrate wander-eval-2026-07-31-base-v1.md
//        npm run read-eval -- 20 --readers 3
//
// Node's native TypeScript support (type stripping) lets this .mts file
// import lib/reading/*.ts directly with explicit ".ts" specifiers — but only
// because lib/reading/* imports ONLY its own siblings that way. Nothing else
// in lib/ is import-safe from a plain Node script: every other lib/*.ts file
// uses extensionless imports (a bundler convention Node's own loader doesn't
// resolve), so this script duplicates the ~8-line provider/client setup
// (lib/providers.ts) directly below, the same way scripts/takedown.mjs notes
// "full normalization lives in lib/address.ts" and does a light check of its
// own instead of importing it.
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import OpenAI from "openai";

import type { ViewportProfile } from "../lib/reading/layout.ts";
import { LANDING_LINES, charsPerLine, foldLines } from "../lib/reading/layout.ts";
import { simulatedRenderer } from "../lib/reading/wrap.ts";
import type { StageWindow } from "../lib/reading/stages.ts";
import { planStages } from "../lib/reading/stages.ts";
import type { ContentPart } from "../lib/reading/protocol.ts";
import {
  READER_PROTOCOL_VERSION,
  READER_SYSTEM_PROMPT,
  buildProbePrompt,
  buildStagePrompt,
  buildVerdictSystemPrompt,
  fieldsFor,
  isAbstain,
  parseStageReply,
} from "../lib/reading/protocol.ts";
import type { ProbeResult, ReadingTrace, StageResult } from "../lib/reading/verdict.ts";
import { QUOTE_FIELDS, parseModelVerdict, ruleVerdict, stageFamily } from "../lib/reading/verdict.ts";
import { pickRecognitionProbe } from "../lib/reading/probe.ts";
import { BLAND_CONTROLS, shuffleSentences } from "../lib/reading/controls.ts";
import type { PageRun, PageRunMeta, ReportConfig, RunKind } from "../lib/reading/report.ts";
import { aggregate, renderReport } from "../lib/reading/report.ts";
import { buildConfusionMatrix, parseWanderEval } from "../lib/reading/calibrate.ts";
import { mulberry32, pickOne, seedFromString } from "../lib/reading/rng.ts";

const [nodeMajor] = process.versions.node.split(".").map(Number);
if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
  console.error(
    `read-eval needs Node >= 22.6 for native TypeScript support (found ${process.versions.node}). ` +
      "This repo's .nvmrc pins a compatible version.",
  );
  process.exit(1);
}

// --- CLI -------------------------------------------------------------------

interface Args {
  count: number;
  seed: string;
  viewport: ViewportProfile;
  address?: string;
  variant?: string;
  model?: string;
  calibrate?: string;
  readers: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { count: 20, seed: "default", viewport: "desktop", readers: 1 };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--seed":
        args.seed = argv[++i];
        break;
      case "--viewport":
        args.viewport = argv[++i] as ViewportProfile;
        break;
      case "--address":
        args.address = argv[++i];
        break;
      case "--variant":
        args.variant = argv[++i];
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--calibrate":
        args.calibrate = argv[++i];
        break;
      case "--readers":
        args.readers = Number(argv[++i]);
        break;
      default:
        positional.push(flag);
    }
  }
  if (positional[0] != null) args.count = Number(positional[0]);
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!Number.isInteger(args.count) || args.count <= 0) {
  console.error("Usage: npm run read-eval -- <count>   (positive integer), or --address <addr>");
  process.exit(1);
}
if (!["desktop", "laptop", "mobile"].includes(args.viewport)) {
  console.error(`--viewport must be one of desktop, laptop, mobile (got "${args.viewport}")`);
  process.exit(1);
}

// --- DB ---------------------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();

// --- Provider/client setup (duplicated from lib/providers.ts — see the file
// header note on why this script can't import it directly) -----------------

type ProviderName = "openrouter" | "google";
const BASE_URLS: Record<ProviderName, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
};

function apiKeyFor(provider: ProviderName): string | undefined {
  const key = provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.GOOGLE_API_KEY;
  return key && key.length > 0 ? key : undefined;
}

const clients = new Map<ProviderName, OpenAI>();
function getClient(provider: ProviderName): OpenAI | undefined {
  const key = apiKeyFor(provider);
  if (!key) return undefined;
  let client = clients.get(provider);
  if (!client) {
    client = new OpenAI({ baseURL: BASE_URLS[provider], apiKey: key });
    clients.set(provider, client);
  }
  return client;
}

/** Reasoning off on every call, same as lib/providers.ts reasoningParams —
 * and doubly appropriate here: a reader does not deliberate for twenty
 * seconds over three lines. */
function reasoningParams(provider: ProviderName): Record<string, unknown> {
  return provider === "google" ? { reasoning_effort: "none" } : { reasoning: { enabled: false } };
}

// --- Reader model resolution -------------------------------------------------

interface ReaderRow {
  slug: string;
  provider: ProviderName;
  temperature: number;
  maxTokens: number;
}

async function resolveReaderModel(): Promise<ReaderRow> {
  if (process.env.EVAL_READER_MODEL) {
    return {
      slug: process.env.EVAL_READER_MODEL,
      provider: (process.env.EVAL_READER_PROVIDER as ProviderName) ?? "openrouter",
      temperature: 0.7,
      maxTokens: 500,
    };
  }
  const { rows } = await db.query<{
    slug: string;
    provider: ProviderName;
    temperature: number;
    max_tokens: number;
  }>(
    `SELECT slug, provider, temperature, max_tokens
       FROM model_registry
      WHERE task = 'reader' AND enabled = true AND health <> 'unavailable'
        AND (health <> 'cooling' OR cooling_until <= now())
      ORDER BY "order"`,
  );
  for (const row of rows) {
    if (apiKeyFor(row.provider)) {
      return { slug: row.slug, provider: row.provider, temperature: row.temperature, maxTokens: row.max_tokens };
    }
  }
  throw new Error(
    "No eligible reader model: model_registry has no enabled task='reader' row with a configured " +
      "provider key (check OPENROUTER_API_KEY/GOOGLE_API_KEY, or set EVAL_READER_MODEL directly).",
  );
}

const readerRow = await resolveReaderModel();

// --- Corpus ------------------------------------------------------------------

interface PageRow {
  address: string;
  content: string;
  model: string | null;
  prompt_variant: string | null;
  temperature: number | null;
  committed_at: string | null;
  likes: string | null;
  dislikes: string | null;
  visits: string | null;
  median_dwell_ms: number | null;
}

async function fetchCorpus(): Promise<PageRow[]> {
  if (args.address) {
    const { rows } = await db.query<PageRow>(
      `SELECT p.address, p.content, p.model, p.prompt_variant, p.temperature, p.committed_at,
              s.likes, s.dislikes, s.visits, s.median_dwell_ms
         FROM pages p LEFT JOIN page_signals s ON s.address = p.address
        WHERE p.address = $1 AND p.status = 'ok' AND p.content IS NOT NULL`,
      [args.address],
    );
    return rows;
  }
  const { rows } = await db.query<PageRow>(
    `SELECT p.address, p.content, p.model, p.prompt_variant, p.temperature, p.committed_at,
            s.likes, s.dislikes, s.visits, s.median_dwell_ms
       FROM pages p LEFT JOIN page_signals s ON s.address = p.address
      WHERE p.status = 'ok' AND p.content IS NOT NULL
        AND ($2::text IS NULL OR p.model = $2)
        AND ($3::text IS NULL OR p.prompt_variant LIKE $3)
      ORDER BY md5(p.address || $1::text)
      LIMIT $4`,
    [args.seed, args.model ?? null, args.variant ?? null, args.count],
  );
  return rows;
}

const corpus = await fetchCorpus();
if (corpus.length === 0) {
  console.error("No matching pages found for this corpus query. Try a wider --variant/--model filter.");
  await db.end();
  process.exit(1);
}

// --- Assemble sample + control pages, one shared shape ----------------------

interface Page {
  address: string;
  content: string;
  kind: RunKind;
  model?: string;
  promptVariant?: string;
  temperature?: number;
  committedAt?: string;
  likes?: number;
  dislikes?: number;
  visits?: number;
  medianDwellMs?: number;
}

const runRng = mulberry32(seedFromString(args.seed));

const samplePages: Page[] = corpus.map((row) => ({
  address: row.address,
  content: row.content,
  kind: "sample",
  model: row.model ?? undefined,
  promptVariant: row.prompt_variant ?? undefined,
  temperature: row.temperature ?? undefined,
  committedAt: row.committed_at ?? undefined,
  likes: row.likes != null ? Number(row.likes) : undefined,
  dislikes: row.dislikes != null ? Number(row.dislikes) : undefined,
  visits: row.visits != null ? Number(row.visits) : undefined,
  medianDwellMs: row.median_dwell_ms ?? undefined,
}));

// Negative controls (plan §"Guards against a confidently-wrong judge"): a
// pause verdict on any of these means this run's judge cannot be trusted.
const shuffleSource = pickOne(corpus, runRng);
const controlPages: Page[] = [
  ...BLAND_CONTROLS.map(
    (text, i): Page => ({ address: `control-bland-${i + 1}`, content: text, kind: "control-bland" }),
  ),
  {
    address: `control-shuffled-${shuffleSource.address}`,
    content: shuffleSentences(shuffleSource.content, runRng),
    kind: "control-shuffled",
  },
];

const allPages: Page[] = [...samplePages, ...controlPages];

// --- Cost estimate ------------------------------------------------------------

const PRICE_PER_MILLION: Record<string, number> = {
  "anthropic/claude-sonnet-5": 10,
  "anthropic/claude-opus-4.8": 25,
  "anthropic/claude-haiku-4.5": 5,
  "z-ai/glm-5.2": 1.32,
  "mistralai/mistral-large-2512": 1.5,
  "deepseek/deepseek-v4-flash": 0.15,
  "moonshotai/kimi-k2.6": 3.41,
};
const CALLS_PER_PAGE = 6; // landing, ~2 screens/end, recall, probe, verdict — rough
const AVG_OUTPUT_TOKENS = 150;
const price = PRICE_PER_MILLION[readerRow.slug] ?? 2.0;
const estimatedCostUsd =
  (allPages.length * CALLS_PER_PAGE * AVG_OUTPUT_TOKENS * (args.readers > 1 ? args.readers : 1)) /
  1e6 *
  price;

console.log(
  `read-eval: ${samplePages.length} sample page(s) + ${controlPages.length} control(s), ` +
    `reader ${readerRow.slug} @ ${args.viewport} — est. ~$${estimatedCostUsd.toFixed(2)}`,
);

// --- Render snapshots for every page up front (needed for cross-page decoys) -

const snapshots = new Map(
  await Promise.all(
    allPages.map(async (p) => [p.address, await simulatedRenderer.render(p.content, p.address, args.viewport)] as const),
  ),
);

function usableLines(lines: string[]): string[] {
  return lines.filter((l) => l.trim().length >= 20);
}

function decoyPoolFor(excludeAddress: string): string[] {
  return allPages
    .filter((p) => p.address !== excludeAddress)
    .flatMap((p) => usableLines(snapshots.get(p.address)!.lines));
}

// --- Reading one page ---------------------------------------------------------

type Msg = { role: "system" | "user" | "assistant"; content: ContentPart[] | string };

async function callReader(readerRowArg: ReaderRow, history: Msg[]): Promise<string> {
  const client = getClient(readerRowArg.provider);
  if (!client) throw new Error(`No ${readerRowArg.provider} client configured (missing API key)`);
  const response = await client.chat.completions.create({
    model: readerRowArg.slug,
    temperature: readerRowArg.temperature,
    max_tokens: readerRowArg.maxTokens,
    // The OpenAI SDK's Message type wants role-specific content shapes; our
    // ContentPart[] is a same-shaped subset (text-only today), so this cast
    // is safe and is exactly the seam the plan calls for — a future
    // image_url part needs no change here.
    messages: history as OpenAI.Chat.ChatCompletionMessageParam[],
    ...reasoningParams(readerRowArg.provider),
  });
  return response.choices[0]?.message.content ?? "";
}

interface ReadResult {
  stageResults: StageResult[];
  probeResult?: ProbeResult;
}

async function readPage(page: Page, readerRowArg: ReaderRow): Promise<ReadResult> {
  const snapshot = snapshots.get(page.address)!;
  const plan = planStages(snapshot);

  let history: Msg[] = [{ role: "system", content: READER_SYSTEM_PROMPT }];
  const stageResults: StageResult[] = [];
  const quoted: string[] = [];

  const revealAndBlindWindows = plan.filter((w): w is StageWindow => w.id !== "probe");
  for (const window of revealAndBlindWindows) {
    if (window.id === "recall") {
      // Prune to [system, ...assistant answers only] — the page text is
      // gone; the reader's own prior answers remain (plan §"Context carry").
      history = [history[0], ...history.filter((m) => m.role === "assistant")];
    }
    const content = buildStagePrompt(window, snapshot.lines);
    history = [...history, { role: "user", content }];
    const raw = await callReader(readerRowArg, history);
    history = [...history, { role: "assistant", content: raw }];

    const fields = fieldsFor(window.id);
    const reply = parseStageReply(raw, fields);
    stageResults.push({ window, reply, raw, abstained: isAbstain(reply, fields) });

    for (const field of QUOTE_FIELDS[stageFamily(window.id)] ?? []) {
      const value = reply[field];
      if (value) quoted.push(value);
    }
  }

  // Probe: continue the same already-pruned, page-blind conversation.
  const decoyPool = decoyPoolFor(page.address);
  const probeRng = mulberry32(seedFromString(`${page.address}|probe`));
  const probe = pickRecognitionProbe(usableLines(snapshot.lines), quoted, decoyPool, probeRng);

  let probeResult: ProbeResult = probe;
  if (probe.usable) {
    const content = buildProbePrompt(probe.options);
    history = [...history, { role: "user", content }];
    const raw = await callReader(readerRowArg, history);
    history = [...history, { role: "assistant", content: raw }];

    const probeWindow: StageWindow = { id: "probe", kind: "blind", upToLine: 0, reachesEnd: true };
    const fields = fieldsFor("probe");
    const reply = parseStageReply(raw, fields);
    stageResults.push({ window: probeWindow, reply, raw, abstained: isAbstain(reply, fields) });

    const pick = reply.PICK?.trim().toUpperCase();
    const sure = reply.SURE?.trim().toUpperCase();
    probeResult = {
      ...probe,
      picked: pick === "A" || pick === "B" || pick === "C" || pick === "D" ? pick : undefined,
      sure: sure === "YES" ? true : sure === "NO" ? false : null,
    };
  }

  return { stageResults, probeResult };
}

function formatTraceForVerdict(trace: ReadingTrace): string {
  return trace.stages
    .map((s) => {
      const fields = Object.entries(s.reply)
        .map(([k, v]) => `${k}: ${v ?? "NOTHING"}`)
        .join(" · ");
      return `${s.window.id}: ${fields}`;
    })
    .join("\n");
}

async function getModelVerdict(readerRowArg: ReaderRow, trace: ReadingTrace) {
  const raw = await callReader(
    { ...readerRowArg, temperature: 0, maxTokens: 200 },
    [
      { role: "system", content: buildVerdictSystemPrompt() },
      { role: "user", content: formatTraceForVerdict(trace) },
    ],
  );
  return parseModelVerdict(raw);
}

async function processPage(page: Page, readerRowArg: ReaderRow): Promise<{ page: Page; trace: ReadingTrace }> {
  try {
    const { stageResults, probeResult } = await readPage(page, readerRowArg);
    const trace: ReadingTrace = {
      address: page.address,
      protocolVersion: READER_PROTOCOL_VERSION,
      readerModel: readerRowArg.slug,
      temperature: readerRowArg.temperature,
      stages: stageResults,
      probe: probeResult,
    };
    trace.modelVerdict = await getModelVerdict(readerRowArg, trace);
    return { page, trace };
  } catch (err) {
    // On error, record and move on — no health mutation (this eval is
    // advisory and out-of-band; it must never degrade production model
    // selection the way a real generation/moderation failure does).
    const trace: ReadingTrace = {
      address: page.address,
      protocolVersion: READER_PROTOCOL_VERSION,
      readerModel: readerRowArg.slug,
      temperature: readerRowArg.temperature,
      stages: [],
      error: err instanceof Error ? err.message : String(err),
    };
    return { page, trace };
  }
}

// --- Run, bounded concurrency -------------------------------------------------

const CONCURRENCY = 4;
const results: { page: Page; trace: ReadingTrace }[] = [];
for (let i = 0; i < allPages.length; i += CONCURRENCY) {
  const chunk = allPages.slice(i, i + CONCURRENCY);
  process.stdout.write(`\rreading ${Math.min(i + CONCURRENCY, allPages.length)}/${allPages.length}…`);
  const chunkResults = await Promise.all(chunk.map((p) => processPage(p, readerRow)));
  results.push(...chunkResults);
}
process.stdout.write("\n");

// --- Reliability probe (--readers N): 3 pages, N independent reads each -----

let reliabilitySection = "";
if (args.readers > 1 && samplePages.length > 0) {
  const subset = samplePages.slice(0, Math.min(3, samplePages.length));
  const lines: string[] = [];
  for (const page of subset) {
    const verdicts: string[] = [];
    for (let i = 0; i < args.readers; i++) {
      const { stageResults, probeResult } = await readPage(page, readerRow);
      const trace: ReadingTrace = {
        address: page.address,
        protocolVersion: READER_PROTOCOL_VERSION,
        readerModel: readerRow.slug,
        temperature: readerRow.temperature,
        stages: stageResults,
        probe: probeResult,
      };
      verdicts.push(ruleVerdict(trace).verdict);
    }
    const agree = verdicts.every((v) => v === verdicts[0]);
    lines.push(`- \`${page.address}\`: [${verdicts.join(", ")}] — ${agree ? "agree" : "DISAGREE"}`);
  }
  reliabilitySection =
    "\n\n## Reliability probe\n\n" +
    `${subset.length} page(s) re-read ${args.readers} times each, independent conversations.\n\n` +
    lines.join("\n") +
    "\n";
}

// --- Aggregate + report --------------------------------------------------------

const pageRuns: PageRun[] = results.map(({ page, trace }) => {
  const snapshot = snapshots.get(page.address)!;
  const meta: PageRunMeta = {
    address: page.address,
    kind: page.kind,
    model: page.model,
    promptVariant: page.promptVariant,
    temperature: page.temperature,
    committedAt: page.committedAt,
    likes: page.likes,
    dislikes: page.dislikes,
    visits: page.visits,
    medianDwellMs: page.medianDwellMs,
  };
  return { meta, lines: snapshot.lines, foldLine: snapshot.foldLine, trace };
});

const aggregateResult = aggregate(pageRuns);

let calibration;
if (args.calibrate) {
  const markdown = await readFile(args.calibrate, "utf8");
  const marks = parseWanderEval(markdown);
  const verdictByAddress = new Map(
    aggregateResult.analyses
      .filter((a) => !a.unreliable && !a.run.trace.error)
      .map((a) => [a.run.meta.address, a.rule.verdict] as const),
  );
  calibration = buildConfusionMatrix(marks, verdictByAddress);
}

const corpusDescription = args.address
  ? `single address: ${args.address}`
  : [
      `status='ok', seed=${args.seed}, limit=${args.count}`,
      args.model ? `model=${args.model}` : null,
      args.variant ? `variant LIKE ${args.variant}` : null,
    ]
      .filter(Boolean)
      .join(", ");

const config: ReportConfig = {
  timestamp: new Date().toISOString(),
  corpusDescription,
  viewportProfile: args.viewport,
  charsPerLine: charsPerLine(args.viewport),
  foldLines: foldLines(args.viewport),
  landingLines: LANDING_LINES,
  protocolVersion: READER_PROTOCOL_VERSION,
  readerModel: readerRow.slug,
  readerTemperature: readerRow.temperature,
  verdictTemperature: 0,
  estimatedCostUsd,
};

const report = renderReport(config, aggregateResult, calibration) + reliabilitySection;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outfile = `read-eval-${stamp}.md`;
await writeFile(outfile, report, "utf8");
console.log(`Wrote ${outfile}`);

if (aggregateResult.controlFailures.length > 0) {
  console.warn(
    `⚠ ${aggregateResult.controlFailures.length} negative control(s) scored pause — this run's verdicts are not trustworthy.`,
  );
}

await db.end();
