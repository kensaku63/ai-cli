/**
 * Auto-Knowledge Pipeline — Crawler → Extractor → Validator → Store
 *
 * CLI entry point for running the full auto-knowledge generation pipeline.
 * Produces auto/tools.jsonl compatible with existing tool-registry.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { crawl } from "./crawler.js";
import { extractBatch } from "./extractor.js";
import { validateBatch } from "./validator.js";
import type { ToolMetadata } from "../tool-registry/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_DIR = join(__dirname, "..", "tool-registry", "data", "auto");
const BUILTIN_DIR = join(__dirname, "..", "tool-registry", "data", "builtin");
const TOOLS_JSONL = join(AUTO_DIR, "tools.jsonl");
const META_JSON = join(AUTO_DIR, "meta.json");

interface PipelineMeta {
  totalGenerated: number;
  validCount: number;
  avgQualityScore: number;
  lastRunAt: string;
  level: string;
  duplicatesSkipped: number;
}

/** Load builtin tool IDs for duplicate detection */
async function loadBuiltinIds(): Promise<Set<string>> {
  const { readdir } = await import("node:fs/promises");
  const ids = new Set<string>();
  try {
    const entries = await readdir(BUILTIN_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await readFile(join(BUILTIN_DIR, entry), "utf-8");
      const meta = JSON.parse(raw) as { id: string };
      ids.add(meta.id);
    }
  } catch {
    // BUILTIN_DIR may not exist in test environments
  }
  return ids;
}

/** Load existing auto-generated tools from JSONL */
async function loadExistingAutoTools(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const content = await readFile(TOOLS_JSONL, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const tool = JSON.parse(line) as { id: string };
      ids.add(tool.id);
    }
  } catch {
    // File doesn't exist yet
  }
  return ids;
}

/** Append tools to JSONL file */
async function appendToJsonl(tools: ToolMetadata[]): Promise<void> {
  await mkdir(AUTO_DIR, { recursive: true });
  const lines = tools.map((t) => JSON.stringify(t)).join("\n");
  try {
    const existing = await readFile(TOOLS_JSONL, "utf-8");
    const content = existing.endsWith("\n") ? existing + lines + "\n" : existing + "\n" + lines + "\n";
    await writeFile(TOOLS_JSONL, content, "utf-8");
  } catch {
    // File doesn't exist, create new
    await writeFile(TOOLS_JSONL, lines + "\n", "utf-8");
  }
}

/** Write pipeline metadata */
async function writeMeta(meta: PipelineMeta): Promise<void> {
  await mkdir(AUTO_DIR, { recursive: true });
  await writeFile(META_JSON, JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

export interface PipelineOptions {
  /** Number of CLI packages to process (default: 100) */
  limit?: number;
  /** Knowledge extraction level (default: L1) */
  level?: "L1" | "L2";
  /** Anthropic API key */
  apiKey?: string;
  /** LLM model (default: claude-haiku-4-5-20251001) */
  model?: string;
  /** Skip LLM extraction (crawl-only mode) */
  crawlOnly?: boolean;
}

export interface PipelineResult {
  crawled: number;
  extracted: number;
  valid: number;
  invalid: number;
  duplicatesSkipped: number;
  avgQualityScore: number;
  tools: ToolMetadata[];
}

/**
 * Run the full auto-knowledge pipeline.
 */
export async function runPipeline(
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const {
    limit = 100,
    level = "L1",
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = "claude-haiku-4-5-20251001",
    crawlOnly = false,
  } = options;

  console.log(`\n=== Auto-Knowledge Pipeline (${level}, limit=${limit}) ===\n`);

  // Step 1: Crawl
  console.log("Step 1: Crawling npm registry...");
  const crawlResults = await crawl({
    limit,
    onProgress: (stage, current, total) => {
      if (stage === "search") {
        process.stdout.write(`\r  Search: ${current} packages found`);
      } else if (stage === "fetch") {
        process.stdout.write(`\r  Fetch: ${current}/${total} packages processed`);
      }
    },
  });
  console.log(`\n  Found ${crawlResults.length} CLI packages with bin field`);

  if (crawlOnly) {
    console.log("\n  Crawl-only mode: skipping extraction.");
    // Output crawl results as preview
    for (const r of crawlResults.slice(0, 10)) {
      console.log(`    ${r.name}: ${r.description.slice(0, 60)}`);
    }
    return {
      crawled: crawlResults.length,
      extracted: 0,
      valid: 0,
      invalid: 0,
      duplicatesSkipped: 0,
      avgQualityScore: 0,
      tools: [],
    };
  }

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for extraction");
  }

  // Step 2: Filter out already-processed and builtin tools
  const builtinIds = await loadBuiltinIds();
  const existingAutoIds = await loadExistingAutoTools();
  const allExistingIds = new Set([...builtinIds, ...existingAutoIds]);

  const newPackages = crawlResults.filter((r) => {
    const binKeys = Object.keys(r.bin);
    const primaryCmd = binKeys.includes(r.name) ? r.name : binKeys[0] ?? r.name;
    return !allExistingIds.has(primaryCmd);
  });

  const duplicatesSkipped = crawlResults.length - newPackages.length;
  console.log(`  New packages to process: ${newPackages.length} (${duplicatesSkipped} already exist)`);

  if (newPackages.length === 0) {
    console.log("  No new packages to process. Done.");
    return {
      crawled: crawlResults.length,
      extracted: 0,
      valid: 0,
      invalid: 0,
      duplicatesSkipped,
      avgQualityScore: 0,
      tools: [],
    };
  }

  // Step 3: Extract with LLM
  console.log(`\nStep 2: Extracting ToolMetadata with ${model} (${level})...`);
  const extractResults = await extractBatch(
    newPackages,
    { level, apiKey, model },
    (completed, total) => {
      process.stdout.write(`\r  Extract: ${completed}/${total}`);
    },
  );
  console.log(`\n  Extracted ${extractResults.length} tools`);

  // Step 4: Validate
  console.log("\nStep 3: Validating...");
  const tools = extractResults.map((r) => r.tool);
  const validation = validateBatch(tools, builtinIds);

  console.log(`  Valid: ${validation.stats.validCount}`);
  console.log(`  Invalid: ${validation.stats.invalidCount}`);
  console.log(`  Avg Quality: ${validation.stats.avgQualityScore}`);

  if (validation.invalid.length > 0) {
    console.log("  Invalid tools:");
    for (const { tool, result } of validation.invalid.slice(0, 5)) {
      console.log(`    ${tool.id}: ${result.errors.join(", ")}`);
    }
  }

  // Step 5: Store valid tools
  if (validation.valid.length > 0) {
    console.log(`\nStep 4: Storing ${validation.valid.length} tools to ${TOOLS_JSONL}...`);
    await appendToJsonl(validation.valid);

    await writeMeta({
      totalGenerated: validation.valid.length + existingAutoIds.size,
      validCount: validation.valid.length,
      avgQualityScore: validation.stats.avgQualityScore,
      lastRunAt: new Date().toISOString(),
      level,
      duplicatesSkipped,
    });

    console.log("  Done!");
  }

  // Summary
  console.log("\n=== Pipeline Summary ===");
  console.log(`  Crawled: ${crawlResults.length}`);
  console.log(`  New: ${newPackages.length}`);
  console.log(`  Valid: ${validation.valid.length}`);
  console.log(`  Quality: ${validation.stats.avgQualityScore}/100 avg`);

  return {
    crawled: crawlResults.length,
    extracted: extractResults.length,
    valid: validation.valid.length,
    invalid: validation.invalid.length,
    duplicatesSkipped,
    avgQualityScore: validation.stats.avgQualityScore,
    tools: validation.valid,
  };
}

// ─── CLI Entry Point ───

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const limit = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "100", 10);
  const level = (args.find((a) => a.startsWith("--level="))?.split("=")[1] ?? "L1") as "L1" | "L2";
  const crawlOnly = args.includes("--crawl-only");
  const model = args.find((a) => a.startsWith("--model="))?.split("=")[1];

  runPipeline({ limit, level, crawlOnly, model })
    .then((result) => {
      process.exit(result.valid > 0 || crawlOnly ? 0 : 1);
    })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      process.exit(1);
    });
}
