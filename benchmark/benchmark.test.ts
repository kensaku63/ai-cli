/**
 * Benchmark — Validation tests
 *
 * Ensures test cases are well-formed and evaluation logic is correct.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BenchmarkCase } from "./types.js";
import { Registry } from "../tool-registry/index.js";

const cases: BenchmarkCase[] = JSON.parse(
  readFileSync(new URL("./cases.json", import.meta.url), "utf-8"),
);

describe("Benchmark — case validation", () => {
  it("has at least 75 test cases", () => {
    assert.ok(cases.length >= 75, `Expected >= 75 cases, got ${cases.length}`);
  });

  it("all cases have required fields", () => {
    for (const c of cases) {
      assert.ok(c.id, `Missing id`);
      assert.ok(c.query, `Missing query for ${c.id}`);
      assert.ok(c.language, `Missing language for ${c.id}`);
      assert.ok(c.difficulty, `Missing difficulty for ${c.id}`);
      assert.ok(c.expected_tool, `Missing expected_tool for ${c.id}`);
      assert.ok(Array.isArray(c.expected_patterns), `Missing expected_patterns for ${c.id}`);
      assert.ok(c.expected_patterns.length > 0, `Empty expected_patterns for ${c.id}`);
      assert.ok(c.category, `Missing category for ${c.id}`);
    }
  });

  it("all IDs are unique", () => {
    const ids = cases.map((c) => c.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, "Duplicate IDs found");
  });

  it("covers both languages", () => {
    const en = cases.filter((c) => c.language === "en");
    const ja = cases.filter((c) => c.language === "ja");
    assert.ok(en.length >= 30, `Expected >= 30 English cases, got ${en.length}`);
    assert.ok(ja.length >= 25, `Expected >= 25 Japanese cases, got ${ja.length}`);
  });

  it("covers all difficulty levels", () => {
    const diffs = new Set(cases.map((c) => c.difficulty));
    assert.ok(diffs.has("simple"), "Missing simple cases");
    assert.ok(diffs.has("compound"), "Missing compound cases");
    assert.ok(diffs.has("pipe"), "Missing pipe cases");
    assert.ok(diffs.has("conditional"), "Missing conditional cases");
  });

  it("each difficulty has at least 10 cases", () => {
    const counts: Record<string, number> = {};
    for (const c of cases) {
      counts[c.difficulty] = (counts[c.difficulty] ?? 0) + 1;
    }
    for (const [diff, count] of Object.entries(counts)) {
      assert.ok(count >= 10, `${diff} has only ${count} cases (need >= 10)`);
    }
  });

  it("expected_tool references existing tools in registry", async () => {
    const registry = new Registry();
    await registry.loadBuiltin();
    const toolIds = new Set(registry.all().map((t) => t.id));

    for (const c of cases) {
      assert.ok(
        toolIds.has(c.expected_tool),
        `Case ${c.id} references unknown tool: ${c.expected_tool}`,
      );
    }
  });

  it("all expected_patterns are valid regex", () => {
    for (const c of cases) {
      for (const p of c.expected_patterns) {
        assert.doesNotThrow(() => new RegExp(p, "i"), `Invalid regex in ${c.id}: ${p}`);
      }
    }
  });
});

describe("Benchmark — evaluateCommand logic", () => {
  // Inline the evaluateCommand function for testing
  function evaluateCommand(
    command: string,
    patterns: string[],
  ): { exactMatch: boolean; partialMatch: boolean } {
    const matched: string[] = [];
    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern, "i").test(command)) {
          matched.push(pattern);
        }
      } catch {
        if (command.includes(pattern)) {
          matched.push(pattern);
        }
      }
    }
    return {
      exactMatch: matched.length === patterns.length,
      partialMatch: matched.length > 0,
    };
  }

  it("exact match when all patterns match", () => {
    const result = evaluateCommand("ls -la", ["ls"]);
    assert.equal(result.exactMatch, true);
    assert.equal(result.partialMatch, true);
  });

  it("partial match when some patterns match", () => {
    const result = evaluateCommand("find . -name '*.ts'", ["find.*\\.ts.*size", "find.*-name.*\\.ts"]);
    assert.equal(result.partialMatch, true);
  });

  it("no match when command is empty", () => {
    const result = evaluateCommand("", ["ls"]);
    assert.equal(result.exactMatch, false);
    assert.equal(result.partialMatch, false);
  });

  it("handles pipe patterns (|) as regex alternation", () => {
    const result = evaluateCommand("curl -O https://example.com/file.txt", ["curl|wget"]);
    assert.equal(result.exactMatch, true);
  });

  it("handles complex regex patterns", () => {
    const result = evaluateCommand("docker run -p 8080:80 nginx", ["docker run.*-p.*8080.*nginx"]);
    assert.equal(result.exactMatch, true);
  });
});
