/**
 * Embedding Index — all-MiniLM-L6-v2 via ONNX Runtime
 *
 * Provides vector embedding-based semantic search for tool discovery.
 * Uses @xenova/transformers for local ONNX inference (no cloud API required).
 * Embeddings are cached to disk to avoid recomputation on startup.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { ToolMetadata } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "data");
const CACHE_FILE = join(CACHE_DIR, "embeddings-cache.json");
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// ─── Types ───

interface EmbeddingCacheData {
  model: string;
  version: number;
  toolHash: string;
  embeddings: Record<string, number[]>;
}

// ─── Math Utilities ───

/** Cosine similarity between two vectors */
export function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Text Preparation ───

/**
 * Build a rich text representation of a tool for embedding.
 * Combines description, intents, tags, and subcommand descriptions
 * to create a comprehensive semantic fingerprint.
 */
function buildEmbeddingText(tool: ToolMetadata): string {
  return [
    tool.description,
    tool.description_ja ?? "",
    ...tool.intents,
    tool.tags.join(", "),
    ...tool.subcommands.map((s) => s.description),
  ]
    .filter(Boolean)
    .join(". ");
}

/** Generate a hash of tool metadata for cache invalidation */
function computeToolHash(tools: ToolMetadata[]): string {
  const data = tools
    .map((t) => `${t.id}:${t.description}:${t.intents.join(",")}`)
    .sort()
    .join("|");
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

// ─── Embedding Index ───

export class EmbeddingIndex {
  private extractor: unknown = null;
  private embeddings: Map<string, Float32Array> = new Map();
  private toolMap: Map<string, ToolMetadata> = new Map();

  /** Build the index: load model, compute or load cached embeddings */
  async build(tools: ToolMetadata[]): Promise<void> {
    for (const t of tools) {
      this.toolMap.set(t.id, t);
    }

    // Try loading from cache first
    const toolHash = computeToolHash(tools);
    const cached = await this.loadCache(toolHash);
    if (cached) {
      this.embeddings = cached;
      return;
    }

    // Build fresh embeddings
    await this.initModel();
    for (const tool of tools) {
      const text = buildEmbeddingText(tool);
      const vec = await this.embed(text);
      this.embeddings.set(tool.id, vec);
    }

    // Persist cache
    await this.saveCache(toolHash);
  }

  /** Embed a query and return ranked results by cosine similarity */
  async search(
    query: string,
    limit = 5,
  ): Promise<{ toolId: string; score: number }[]> {
    await this.initModel();
    const qVec = await this.embed(query);

    const results: { toolId: string; score: number }[] = [];
    for (const [id, vec] of this.embeddings) {
      results.push({ toolId: id, score: cosineSimilarity(qVec, vec) });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Get a tool by ID */
  getTool(id: string): ToolMetadata | undefined {
    return this.toolMap.get(id);
  }

  /** Number of indexed tools */
  get size(): number {
    return this.embeddings.size;
  }

  // ─── Internal ───

  private async initModel(): Promise<void> {
    if (this.extractor) return;
    // Dynamic import to allow graceful failure if package not installed
    const { pipeline } = await import("@xenova/transformers");
    this.extractor = await pipeline("feature-extraction", MODEL_ID);
  }

  private async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) throw new Error("Model not initialized");
    const fn = this.extractor as (
      text: string,
      options: { pooling: string; normalize: boolean },
    ) => Promise<{ data: ArrayLike<number> }>;
    const output = await fn(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  private async loadCache(
    toolHash: string,
  ): Promise<Map<string, Float32Array> | null> {
    try {
      const raw = await readFile(CACHE_FILE, "utf-8");
      const data: EmbeddingCacheData = JSON.parse(raw);
      if (data.model !== MODEL_ID || data.toolHash !== toolHash) return null;

      const map = new Map<string, Float32Array>();
      for (const [id, arr] of Object.entries(data.embeddings)) {
        map.set(id, new Float32Array(arr));
      }
      return map;
    } catch {
      return null;
    }
  }

  private async saveCache(toolHash: string): Promise<void> {
    const data: EmbeddingCacheData = {
      model: MODEL_ID,
      version: 1,
      toolHash,
      embeddings: {},
    };
    for (const [id, vec] of this.embeddings) {
      data.embeddings[id] = Array.from(vec);
    }
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(data));
    } catch {
      // Non-critical: cache write failure is acceptable
    }
  }
}
