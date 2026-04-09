/**
 * Benchmark Case Auto-Generator
 *
 * Reads all tool metadata from the registry and uses Claude API to generate
 * diverse benchmark test cases. Deduplicates against existing cases.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx benchmark/generate.ts
 *   ANTHROPIC_API_KEY=... npx tsx benchmark/generate.ts --dry-run    # preview without writing
 *   ANTHROPIC_API_KEY=... npx tsx benchmark/generate.ts --tools git,docker  # specific tools only
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkCase } from "./types.js";

// ─── Config ───

const TOOLS_DIR = join(import.meta.dirname, "../tool-registry/data/builtin");
const CASES_FILE = join(import.meta.dirname, "cases.json");
const OUTPUT_FILE = join(import.meta.dirname, "cases.json");

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1000;
const MAX_RETRIES = 3;
const CASES_PER_TOOL = 4; // target: 128 × 4 = 512

// ─── Types ───

interface ToolMeta {
  id: string;
  name: string;
  type: string;
  categories: string[];
  tags: string[];
  description: string;
  description_ja?: string;
  subcommands: { name: string; description: string; usage?: string }[];
  intents: string[];
}

interface GeneratedCase {
  query: string;
  language: "en" | "ja";
  difficulty: "simple" | "compound" | "pipe" | "conditional";
  expected_tool: string;
  expected_patterns: string[];
  category: string;
}

// ─── CLI Args ───

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, toolFilter: null as string[] | null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") opts.dryRun = true;
    if (args[i] === "--tools") opts.toolFilter = args[++i]?.split(",") ?? null;
  }
  return opts;
}

// ─── Load Tools ───

async function loadTools(filter: string[] | null): Promise<ToolMeta[]> {
  const files = await readdir(TOOLS_DIR);
  const tools: ToolMeta[] = [];
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(await readFile(join(TOOLS_DIR, f), "utf-8"));
    if (!filter || filter.includes(data.id)) {
      tools.push(data);
    }
  }
  return tools.sort((a, b) => a.id.localeCompare(b.id));
}

// ─── Load Existing Cases ───

async function loadExistingCases(): Promise<BenchmarkCase[]> {
  try {
    return JSON.parse(await readFile(CASES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

// ─── Claude API Call ───

async function callClaude(
  apiKey: string,
  system: string,
  userMsg: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: userMsg }],
        }),
      });

      if (res.status === 429) {
        const wait = (attempt + 1) * 5000;
        console.log(`  Rate limited, waiting ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = (await res.json()) as {
        content: { type: string; text: string }[];
      };
      return json.content[0].text;
    } catch (e) {
      if (attempt === MAX_RETRIES - 1) throw e;
      console.log(`  Retry ${attempt + 1}/${MAX_RETRIES}: ${(e as Error).message.slice(0, 100)}`);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw new Error("Max retries exceeded");
}

// ─── Prompt Construction ───

function buildSystemPrompt(): string {
  return `You are a benchmark test case generator for a CLI tool discovery engine.
Your job is to create realistic natural language queries that a user would type to invoke CLI tools.

Output ONLY a valid JSON array of objects. No markdown, no explanation, no code fences.

Each object must have exactly these fields:
- "query": Natural language request (realistic, specific, with concrete values like filenames/ports/URLs)
- "language": "en" or "ja"
- "difficulty": one of "simple", "compound", "pipe", "conditional"
- "expected_tool": the primary tool ID that should be selected
- "expected_patterns": array of regex patterns that the generated command should match (use | for alternatives within a single pattern)
- "category": task category (filesystem, vcs, network, system, search, container, package, database, text, build, security, monitoring, runtime, terminal, devops, cloud, http)

Difficulty definitions:
- "simple": Single command, minimal options (e.g., "show disk usage" → df)
- "compound": Single command with specific options/arguments (e.g., "find TypeScript files larger than 1MB" → find ... -name *.ts -size +1M)
- "pipe": Requires piping multiple commands (e.g., "count files" → ls | wc -l)
- "conditional": Requires conditional logic or chained operations (e.g., "if tests pass then deploy" → npm test && npm run deploy)

Rules for expected_patterns:
- Patterns are regex tested against the generated command string
- Use the actual command name(s) that would appear in the output
- For pipe cases, include pipe-related patterns (e.g., "sort.*uniq" or "grep.*wc")
- For conditional cases, include conditional operators (&&, ||, if, test)
- Keep patterns flexible enough to match reasonable command variations
- Use | within a pattern string for alternatives (e.g., "curl|wget")

Rules for queries:
- Use realistic, specific values (real filenames, ports, URLs, package names)
- Vary the phrasing — don't always use "show me" or "list"
- Japanese queries should sound natural, not translated
- Don't repeat the same idea in both languages — make each query unique`;
}

function buildUserPrompt(tool: ToolMeta, existingQueries: Set<string>): string {
  const subcmds = tool.subcommands.length > 0
    ? `\nSubcommands:\n${tool.subcommands.map((s) => `  - ${s.name}: ${s.description}${s.usage ? ` (${s.usage})` : ""}`).join("\n")}`
    : "";

  const existingForTool = [...existingQueries]
    .filter((q) => q.includes(tool.id) || q.includes(tool.name))
    .slice(0, 3);

  const avoidMsg = existingForTool.length > 0
    ? `\n\nAvoid queries similar to these (already exist):\n${existingForTool.map((q) => `- "${q}"`).join("\n")}`
    : "";

  return `Generate exactly ${CASES_PER_TOOL} benchmark test cases for the following tool.
Include a mix: at least 1 EN and 1 JA query, and vary the difficulty levels.
For tools with subcommands, test different subcommands.
For simple tools (no subcommands), focus on different use cases and option combinations.

Tool: ${tool.id}
Description: ${tool.description}
${tool.description_ja ? `Description (JA): ${tool.description_ja}` : ""}
Categories: ${tool.categories.join(", ")}
Tags: ${tool.tags.join(", ")}${subcmds}
Intents: ${tool.intents.slice(0, 8).join(", ")}${avoidMsg}

Return a JSON array of ${CASES_PER_TOOL} objects.`;
}

// ─── Parse & Validate ───

function parseResponse(text: string, toolId: string): GeneratedCase[] {
  // Extract JSON array from response
  let jsonStr = text.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  // Find the array boundaries
  const start = jsonStr.indexOf("[");
  const end = jsonStr.lastIndexOf("]");
  if (start === -1 || end === -1) {
    console.log(`  Warning: No JSON array found for ${toolId}`);
    return [];
  }
  jsonStr = jsonStr.slice(start, end + 1);

  let parsed: unknown[];
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.log(`  Warning: JSON parse failed for ${toolId}: ${(e as Error).message}`);
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const valid: GeneratedCase[] = [];
  for (const item of parsed) {
    if (!isValidCase(item, toolId)) continue;
    valid.push(item as GeneratedCase);
  }
  return valid;
}

function isValidCase(item: unknown, toolId: string): boolean {
  if (typeof item !== "object" || item === null) return false;
  const c = item as Record<string, unknown>;

  if (typeof c.query !== "string" || c.query.length < 5) return false;
  if (!["en", "ja"].includes(c.language as string)) return false;
  if (!["simple", "compound", "pipe", "conditional"].includes(c.difficulty as string)) return false;
  if (typeof c.expected_tool !== "string") return false;
  if (!Array.isArray(c.expected_patterns) || c.expected_patterns.length === 0) return false;
  if (typeof c.category !== "string") return false;

  // Validate regex patterns
  for (const p of c.expected_patterns) {
    if (typeof p !== "string") return false;
    try {
      new RegExp(p);
    } catch {
      return false;
    }
  }

  return true;
}

// ─── Deduplication ───

function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function isDuplicate(query: string, existing: Set<string>): boolean {
  const norm = normalizeQuery(query);
  if (existing.has(norm)) return true;

  // Check similarity: if >70% word overlap, consider duplicate
  const words = new Set(norm.split(" "));
  for (const eq of existing) {
    const eWords = new Set(eq.split(" "));
    const intersection = [...words].filter((w) => eWords.has(w));
    const overlap = intersection.length / Math.max(words.size, eWords.size);
    if (overlap > 0.7) return true;
  }
  return false;
}

// ─── ID Generation ───

function generateId(
  difficulty: string,
  language: string,
  counters: Map<string, number>,
): string {
  const key = `${difficulty}-${language}`;
  const count = (counters.get(key) ?? 0) + 1;
  counters.set(key, count);
  return `${key}-${String(count).padStart(3, "0")}`;
}

// ─── Main ───

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const opts = parseArgs();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable required");
    process.exit(1);
  }

  console.log("=== Benchmark Case Auto-Generator ===\n");

  // Load data
  const [tools, existingCases] = await Promise.all([
    loadTools(opts.toolFilter),
    loadExistingCases(),
  ]);

  console.log(`Tools: ${tools.length}`);
  console.log(`Existing cases: ${existingCases.length}`);
  console.log(`Target: ${tools.length * CASES_PER_TOOL} new cases\n`);

  // Build dedup set from existing
  const existingQueries = new Set(existingCases.map((c) => normalizeQuery(c.query)));
  const systemPrompt = buildSystemPrompt();

  // Generate in batches
  const allGenerated: GeneratedCase[] = [];
  let processed = 0;

  for (let i = 0; i < tools.length; i += BATCH_SIZE) {
    const batch = tools.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (tool) => {
        const userPrompt = buildUserPrompt(tool, existingQueries);
        try {
          const response = await callClaude(apiKey, systemPrompt, userPrompt);
          const cases = parseResponse(response, tool.id);
          return { toolId: tool.id, cases };
        } catch (e) {
          console.log(`  Error for ${tool.id}: ${(e as Error).message.slice(0, 100)}`);
          return { toolId: tool.id, cases: [] };
        }
      }),
    );

    for (const { toolId, cases } of results) {
      let added = 0;
      for (const c of cases) {
        if (isDuplicate(c.query, existingQueries)) {
          continue;
        }
        existingQueries.add(normalizeQuery(c.query));
        allGenerated.push(c);
        added++;
      }
      processed++;
      console.log(
        `[${processed}/${tools.length}] ${toolId}: ${added}/${cases.length} new cases`,
      );
    }

    if (i + BATCH_SIZE < tools.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`\nGenerated: ${allGenerated.length} new cases`);

  // Assign IDs (continuing from existing max counters)
  const counters = new Map<string, number>();
  for (const c of existingCases) {
    const match = c.id.match(/^(\w+-\w+)-(\d+)$/);
    if (match) {
      const key = match[1];
      const num = parseInt(match[2], 10);
      counters.set(key, Math.max(counters.get(key) ?? 0, num));
    }
  }

  const newCases: BenchmarkCase[] = allGenerated.map((c) => ({
    id: generateId(c.difficulty, c.language, counters),
    query: c.query,
    language: c.language,
    difficulty: c.difficulty,
    expected_tool: c.expected_tool,
    expected_patterns: c.expected_patterns,
    category: c.category,
  }));

  // Merge
  const merged = [...existingCases, ...newCases];

  // Stats
  const stats = {
    total: merged.length,
    existing: existingCases.length,
    generated: newCases.length,
    byDifficulty: {} as Record<string, number>,
    byLanguage: {} as Record<string, number>,
    byTool: {} as Record<string, number>,
  };
  for (const c of merged) {
    stats.byDifficulty[c.difficulty] = (stats.byDifficulty[c.difficulty] ?? 0) + 1;
    stats.byLanguage[c.language] = (stats.byLanguage[c.language] ?? 0) + 1;
    stats.byTool[c.expected_tool] = (stats.byTool[c.expected_tool] ?? 0) + 1;
  }

  console.log("\n=== Summary ===");
  console.log(`Total cases: ${stats.total}`);
  console.log(`By difficulty: ${JSON.stringify(stats.byDifficulty)}`);
  console.log(`By language: ${JSON.stringify(stats.byLanguage)}`);
  console.log(`Unique tools covered: ${Object.keys(stats.byTool).length}`);

  if (opts.dryRun) {
    console.log("\n[Dry run] Would write to:", OUTPUT_FILE);
    // Print sample
    console.log("\nSample generated cases:");
    for (const c of newCases.slice(0, 5)) {
      console.log(`  ${c.id}: [${c.language}/${c.difficulty}] "${c.query}" → ${c.expected_tool}`);
    }
  } else {
    await writeFile(OUTPUT_FILE, JSON.stringify(merged, null, 2) + "\n");
    console.log(`\nWritten to: ${OUTPUT_FILE}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
