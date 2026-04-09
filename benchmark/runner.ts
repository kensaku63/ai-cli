/**
 * Translation Quality Benchmark Runner
 *
 * Two modes:
 *   1. Discovery-only (no API key): measures tool selection accuracy
 *   2. Full pipeline (needs ANTHROPIC_API_KEY): measures command generation + execution
 *
 * Usage:
 *   npx tsx benchmark/runner.ts                    # discovery-only
 *   npx tsx benchmark/runner.ts --full             # full pipeline (needs API key)
 *   npx tsx benchmark/runner.ts --difficulty pipe  # filter by difficulty
 *   npx tsx benchmark/runner.ts --language ja      # filter by language
 */

import { readFile } from "node:fs/promises";
import { AiCliEngine } from "../engine.js";
import type { BenchmarkCase, BenchmarkResult, BenchmarkSummary } from "./types.js";

// ─── CLI Argument Parsing ───

interface RunOptions {
  full: boolean;
  difficulty?: string;
  language?: string;
  category?: string;
}

function parseArgs(): RunOptions {
  const args = process.argv.slice(2);
  const opts: RunOptions = { full: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--full":
        opts.full = true;
        break;
      case "--difficulty":
        opts.difficulty = args[++i];
        break;
      case "--language":
        opts.language = args[++i];
        break;
      case "--category":
        opts.category = args[++i];
        break;
    }
  }
  return opts;
}

// ─── Discovery Evaluation ───

async function evaluateDiscovery(
  engine: AiCliEngine,
  testCase: BenchmarkCase,
): Promise<BenchmarkResult> {
  const start = Date.now();

  try {
    const candidates = await engine.discover(testCase.query, 5);
    const elapsed = Date.now() - start;

    if (candidates.length === 0) {
      return {
        id: testCase.id,
        query: testCase.query,
        discoveryMatch: false,
        discoveryTool: null,
        discoveryConfidence: 0,
        discoveryTimeMs: elapsed,
      };
    }

    const topTool = candidates[0]!;
    const discoveryMatch = topTool.tool.id === testCase.expected_tool;

    // Also check if expected tool is in top 3 (relaxed match)
    const inTop3 = candidates.slice(0, 3).some((c) => c.tool.id === testCase.expected_tool);

    return {
      id: testCase.id,
      query: testCase.query,
      discoveryMatch,
      discoveryMatchTop3: inTop3,
      discoveryTool: topTool.tool.id,
      discoveryConfidence: topTool.confidence,
      discoveryTimeMs: elapsed,
      discoveryCandidates: candidates.slice(0, 3).map((c) => c.tool.id),
    };
  } catch (err) {
    return {
      id: testCase.id,
      query: testCase.query,
      discoveryMatch: false,
      discoveryTool: null,
      discoveryConfidence: 0,
      discoveryTimeMs: Date.now() - start,
      error: String(err),
    };
  }
}

// ─── Command Evaluation ───

function evaluateCommand(
  command: string,
  patterns: string[],
): { exactMatch: boolean; partialMatch: boolean; matchedPatterns: string[] } {
  const matchedPatterns: string[] = [];

  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, "i").test(command)) {
        matchedPatterns.push(pattern);
      }
    } catch {
      // Invalid regex — try literal match
      if (command.includes(pattern)) {
        matchedPatterns.push(pattern);
      }
    }
  }

  return {
    exactMatch: matchedPatterns.length === patterns.length,
    partialMatch: matchedPatterns.length > 0,
    matchedPatterns,
  };
}

// ─── Full Pipeline Evaluation ───

async function evaluateFull(
  engine: AiCliEngine,
  testCase: BenchmarkCase,
): Promise<BenchmarkResult> {
  const discovery = await evaluateDiscovery(engine, testCase);

  try {
    const result = await engine.execute(testCase.query, {
      dryRun: true,
      autoApprove: true,
      timeout: 30_000,
    });

    const cmdEval = evaluateCommand(result.command, testCase.expected_patterns);

    return {
      ...discovery,
      command: result.command,
      commandExactMatch: cmdEval.exactMatch,
      commandPartialMatch: cmdEval.partialMatch,
      matchedPatterns: cmdEval.matchedPatterns,
      generatedTool: result.tool.id,
      status: result.status,
    };
  } catch (err) {
    return {
      ...discovery,
      command: null,
      commandExactMatch: false,
      commandPartialMatch: false,
      error: String(err),
    };
  }
}

// ─── Summary Calculation ───

function summarize(results: BenchmarkResult[], cases: BenchmarkCase[]): BenchmarkSummary {
  const total = results.length;

  // Discovery metrics
  const discoveryHits = results.filter((r) => r.discoveryMatch).length;
  const discoveryTop3Hits = results.filter((r) => r.discoveryMatchTop3).length;

  // Command metrics (only if full mode ran)
  const withCommand = results.filter((r) => r.command !== undefined);
  const commandExactHits = withCommand.filter((r) => r.commandExactMatch).length;
  const commandPartialHits = withCommand.filter((r) => r.commandPartialMatch).length;

  // Breakdown by difficulty
  const difficulties = [...new Set(cases.map((c) => c.difficulty))];
  const byDifficulty: Record<string, { total: number; discoveryRate: number; commandRate: number }> = {};

  for (const diff of difficulties) {
    const diffCases = cases.filter((c) => c.difficulty === diff).map((c) => c.id);
    const diffResults = results.filter((r) => diffCases.includes(r.id));
    const diffTotal = diffResults.length;
    if (diffTotal === 0) continue;

    byDifficulty[diff] = {
      total: diffTotal,
      discoveryRate: diffResults.filter((r) => r.discoveryMatch).length / diffTotal,
      commandRate: withCommand.length > 0
        ? diffResults.filter((r) => r.commandPartialMatch).length / diffTotal
        : 0,
    };
  }

  // Breakdown by language
  const languages = [...new Set(cases.map((c) => c.language))];
  const byLanguage: Record<string, { total: number; discoveryRate: number; commandRate: number }> = {};

  for (const lang of languages) {
    const langCases = cases.filter((c) => c.language === lang).map((c) => c.id);
    const langResults = results.filter((r) => langCases.includes(r.id));
    const langTotal = langResults.length;
    if (langTotal === 0) continue;

    byLanguage[lang] = {
      total: langTotal,
      discoveryRate: langResults.filter((r) => r.discoveryMatch).length / langTotal,
      commandRate: withCommand.length > 0
        ? langResults.filter((r) => r.commandPartialMatch).length / langTotal
        : 0,
    };
  }

  return {
    total,
    discovery: {
      exactMatchRate: discoveryHits / total,
      top3MatchRate: discoveryTop3Hits / total,
      hits: discoveryHits,
      top3Hits: discoveryTop3Hits,
    },
    command: withCommand.length > 0
      ? {
          exactMatchRate: commandExactHits / withCommand.length,
          partialMatchRate: commandPartialHits / withCommand.length,
          exactHits: commandExactHits,
          partialHits: commandPartialHits,
          total: withCommand.length,
        }
      : null,
    byDifficulty,
    byLanguage,
  };
}

// ─── Report Formatting ───

function printReport(summary: BenchmarkSummary, results: BenchmarkResult[]): void {
  console.log("\n═══════════════════════════════════════════");
  console.log("  ai-cli Translation Quality Benchmark");
  console.log("═══════════════════════════════════════════\n");

  console.log(`Total cases: ${summary.total}\n`);

  // Discovery
  console.log("── Discovery (Tool Selection) ──");
  console.log(`  Top-1 accuracy: ${(summary.discovery.exactMatchRate * 100).toFixed(1)}% (${summary.discovery.hits}/${summary.total})`);
  console.log(`  Top-3 accuracy: ${(summary.discovery.top3MatchRate * 100).toFixed(1)}% (${summary.discovery.top3Hits}/${summary.total})`);

  // Command
  if (summary.command) {
    console.log("\n── Command Generation ──");
    console.log(`  Exact match:   ${(summary.command.exactMatchRate * 100).toFixed(1)}% (${summary.command.exactHits}/${summary.command.total})`);
    console.log(`  Partial match: ${(summary.command.partialMatchRate * 100).toFixed(1)}% (${summary.command.partialHits}/${summary.command.total})`);
  }

  // By difficulty
  console.log("\n── By Difficulty ──");
  for (const [diff, stats] of Object.entries(summary.byDifficulty)) {
    const cmdStr = stats.commandRate > 0 ? ` | cmd: ${(stats.commandRate * 100).toFixed(1)}%` : "";
    console.log(`  ${diff.padEnd(12)} (n=${stats.total}): discovery: ${(stats.discoveryRate * 100).toFixed(1)}%${cmdStr}`);
  }

  // By language
  console.log("\n── By Language ──");
  for (const [lang, stats] of Object.entries(summary.byLanguage)) {
    const cmdStr = stats.commandRate > 0 ? ` | cmd: ${(stats.commandRate * 100).toFixed(1)}%` : "";
    console.log(`  ${lang.padEnd(4)} (n=${stats.total}): discovery: ${(stats.discoveryRate * 100).toFixed(1)}%${cmdStr}`);
  }

  // Failures
  const failures = results.filter((r) => !r.discoveryMatch);
  if (failures.length > 0) {
    console.log(`\n── Discovery Misses (${failures.length}) ──`);
    for (const f of failures) {
      console.log(`  ${f.id}: "${f.query}"`);
      console.log(`    expected: ${results.find(() => true) ? "" : ""}${f.id.split("-").slice(0, 2).join("-")} → got: ${f.discoveryTool} (conf: ${f.discoveryConfidence?.toFixed(1) ?? "N/A"})`);
      if (f.discoveryCandidates) {
        console.log(`    top-3: [${f.discoveryCandidates.join(", ")}]`);
      }
    }
  }

  console.log("\n═══════════════════════════════════════════\n");
}

// ─── Main ───

async function main(): Promise<void> {
  const opts = parseArgs();

  // Load test cases
  const raw = await readFile(new URL("./cases.json", import.meta.url), "utf-8");
  let cases: BenchmarkCase[] = JSON.parse(raw);

  // Apply filters
  if (opts.difficulty) {
    cases = cases.filter((c) => c.difficulty === opts.difficulty);
  }
  if (opts.language) {
    cases = cases.filter((c) => c.language === opts.language);
  }
  if (opts.category) {
    cases = cases.filter((c) => c.category === opts.category);
  }

  if (cases.length === 0) {
    console.log("No matching test cases found.");
    process.exit(1);
  }

  console.log(`Running ${cases.length} benchmark cases (mode: ${opts.full ? "full" : "discovery"})...\n`);

  const engine = new AiCliEngine();
  const results: BenchmarkResult[] = [];

  for (const testCase of cases) {
    const result = opts.full
      ? await evaluateFull(engine, testCase)
      : await evaluateDiscovery(engine, testCase);
    results.push(result);

    // Progress indicator
    const icon = result.discoveryMatch ? "✓" : "✗";
    process.stdout.write(`  ${icon} ${testCase.id}\n`);
  }

  const summary = summarize(results, cases);
  printReport(summary, results);

  // Write JSON results for further analysis
  const output = JSON.stringify({ summary, results }, null, 2);
  const outPath = new URL("./results.json", import.meta.url);
  await import("node:fs/promises").then((fs) => fs.writeFile(outPath, output));
  console.log(`Results written to benchmark/results.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
