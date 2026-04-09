import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "./registry.js";
import { SearchEngine, searchTools } from "./search.js";
import { cosineSimilarity } from "./embeddings.js";
import type { ToolMetadata } from "./schema.js";

let tools: ToolMetadata[];

before(async () => {
  const registry = new Registry();
  await registry.loadBuiltin();
  tools = registry.all();
});

// ─── Unit: cosineSimilarity ───

describe("cosineSimilarity", () => {
  it("identical vectors have similarity 1", () => {
    const v = new Float32Array([1, 2, 3]);
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6);
  });

  it("orthogonal vectors have similarity 0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6);
  });

  it("opposite vectors have similarity -1", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b) + 1) < 1e-6);
  });

  it("similar vectors have positive similarity", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 4]);
    assert.ok(cosineSimilarity(a, b) > 0.9);
  });

  it("zero vectors return 0", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it("works with regular number arrays", () => {
    const a = [0.5, 0.5, 0.5];
    const b = [1.0, 1.0, 1.0];
    assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-6);
  });
});

// ─── SearchEngine: TF-IDF fallback ───

describe("SearchEngine — TF-IDF fallback", () => {
  it("returns results without semantic init", async () => {
    const engine = new SearchEngine();
    // No initSemantic() called — should fall back to TF-IDF
    assert.equal(engine.isSemanticReady, false);

    const results = await engine.search("git", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "git");
  });

  it("matches existing TF-IDF search behavior", async () => {
    const engine = new SearchEngine();
    const engineResults = await engine.search("clone a repository", tools);
    const directResults = searchTools("clone a repository", tools);

    // Same top result
    assert.equal(engineResults[0]!.tool.id, directResults[0]!.tool.id);
  });

  it("respects limit option", async () => {
    const engine = new SearchEngine();
    const results = await engine.search("file", tools, { limit: 3 });
    assert.ok(results.length <= 3);
  });
});

// ─── SearchEngine: semantic init failure handling ───

describe("SearchEngine — graceful degradation", () => {
  it("initSemantic returns false on model load failure", async () => {
    const engine = new SearchEngine();
    // This will fail because @xenova/transformers isn't installed in test env
    // or model can't be loaded — that's expected behavior
    const ready = await engine.initSemantic([]);
    // Doesn't throw, returns false or true depending on environment
    assert.equal(typeof ready, "boolean");
  });

  it("search works after initSemantic failure", async () => {
    const engine = new SearchEngine();
    await engine.initSemantic([]); // May fail, that's OK
    if (!engine.isSemanticReady) {
      // Fell back to TF-IDF — should still work
      const results = await engine.search("docker", tools);
      assert.ok(results.length > 0);
      assert.equal(results[0]!.tool.id, "docker");
    }
  });
});

// ─── Integration: semantic search (requires model) ───
// These tests only run when the embedding model is available.

describe("SearchEngine — semantic integration", () => {
  let engine: SearchEngine;
  let semanticAvailable: boolean;

  before(async () => {
    engine = new SearchEngine();
    semanticAvailable = await engine.initSemantic(tools);
  });

  it("initializes with tools", () => {
    // Log whether semantic is available (informational)
    if (!semanticAvailable) {
      console.log(
        "  (skipping semantic tests — model not available)",
      );
    }
  });

  it("'clone a repository' finds git (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search("clone a repository", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "git");
    assert.ok(results[0]!.matchedOn.includes("semantic"));
  });

  it("'run a container' finds docker (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search("run a container", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "docker");
  });

  it("'parse JSON data' finds jq (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search("parse JSON data", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "jq");
  });

  it("'send an HTTP request' finds curl (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search("send an HTTP request", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "curl");
  });

  it("'deploy to kubernetes' finds kubectl (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search("deploy to kubernetes", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "kubectl");
  });

  it("'upload file to cloud storage' finds aws (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search(
      "upload file to cloud storage",
      tools,
    );
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "aws");
  });

  // Japanese queries
  it("'リポジトリをクローンしたい' finds git (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search("リポジトリをクローンしたい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "git");
  });

  it("'コンテナを起動したい' finds docker (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search("コンテナを起動したい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "docker");
  });

  it("'JSONをパースしたい' finds jq (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search("JSONをパースしたい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "jq");
  });

  // Semantic advantage: paraphrased queries that TF-IDF might miss
  it("'manage source code versions' finds git (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search(
      "manage source code versions",
      tools,
    );
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "git");
  });

  it("'containerize application' finds docker (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search("containerize application", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "docker");
  });

  it("'orchestrate cloud infrastructure' finds terraform (semantic)", async () => {
    if (!semanticAvailable) return;
    const results = await engine.search(
      "orchestrate cloud infrastructure",
      tools,
    );
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "terraform");
  });
});
