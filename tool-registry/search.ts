/**
 * Tool Registry — Search engine
 *
 * Two-stage search (MCP-Zero inspired):
 *   Stage 1: Semantic embedding retrieval via all-MiniLM-L6-v2 (ONNX)
 *   Stage 2: Re-rank with TF-IDF token-based scoring
 *
 * Falls back to TF-IDF only when the embedding model is unavailable.
 */

import type { ToolMetadata, SearchResult } from "./schema.js";
import { EmbeddingIndex } from "./embeddings.js";

/** Tokenize text into lowercase words, removing punctuation */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Generate character n-grams for fuzzy matching */
function ngrams(text: string, n: number): Set<string> {
  const s = text.toLowerCase();
  const result = new Set<string>();
  for (let i = 0; i <= s.length - n; i++) {
    result.add(s.slice(i, i + n));
  }
  return result;
}

/** Jaccard similarity between two sets */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/** Word overlap ratio: how many query tokens appear in the target text */
function wordOverlap(queryTokens: string[], targetTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const targetSet = new Set(targetTokens);
  let matches = 0;
  for (const q of queryTokens) {
    if (targetSet.has(q)) matches++;
  }
  return matches / queryTokens.length;
}

/** Build a searchable text blob from a tool's metadata */
function buildSearchText(tool: ToolMetadata): string {
  const parts = [
    tool.name,
    tool.description,
    tool.description_ja ?? "",
    tool.tags.join(" "),
    tool.categories.join(" "),
    ...tool.subcommands.map((s) => `${s.name} ${s.description}`),
  ];
  return parts.join(" ");
}

/** Score a single tool against a query */
function scoreTool(
  query: string,
  queryTokens: string[],
  queryNgrams: Set<string>,
  tool: ToolMetadata,
): { score: number; matchedOn: string[] } {
  const matchedOn: string[] = [];
  let score = 0;
  const q = query.toLowerCase();

  // 1. Exact name match (highest signal)
  if (q === tool.name.toLowerCase() || q === tool.id.toLowerCase()) {
    score += 10;
    matchedOn.push("name");
  } else if (q.includes(tool.name.toLowerCase()) || q.includes(tool.id.toLowerCase())) {
    score += 5;
    matchedOn.push("name");
  }

  // 2. Intent matching (high signal — pre-defined natural language mappings)
  let bestIntentScore = 0;
  for (const intent of tool.intents) {
    const intentTokens = tokenize(intent);
    const overlap = wordOverlap(queryTokens, intentTokens);
    if (overlap > bestIntentScore) bestIntentScore = overlap;

    // Also check n-gram similarity for fuzzy matching
    const intentNgrams = ngrams(intent, 3);
    const sim = jaccard(queryNgrams, intentNgrams);
    if (sim > bestIntentScore) bestIntentScore = sim;
  }
  if (bestIntentScore > 0) {
    score += bestIntentScore * 6;
    matchedOn.push("intents");
  }

  // 3. Subcommand name match
  for (const sub of tool.subcommands) {
    if (q.includes(sub.name.toLowerCase())) {
      score += 3;
      matchedOn.push(`subcommand:${sub.name}`);
      break;
    }
  }

  // 4. Tag match
  for (const tag of tool.tags) {
    if (queryTokens.includes(tag.toLowerCase())) {
      score += 2;
      if (!matchedOn.includes("tags")) matchedOn.push("tags");
    }
  }

  // 5. General text similarity (description + categories + subcommand descriptions)
  const searchText = buildSearchText(tool);
  const searchTokens = tokenize(searchText);
  const textOverlap = wordOverlap(queryTokens, searchTokens);
  if (textOverlap > 0) {
    score += textOverlap * 3;
    if (!matchedOn.includes("description")) matchedOn.push("description");
  }

  return { score, matchedOn };
}

export interface SearchOptions {
  /** Maximum number of results to return (default: 5) */
  limit?: number;
  /** Minimum score threshold (default: 0.5) */
  threshold?: number;
}

/** Search tools by natural language query */
export function searchTools(
  query: string,
  tools: ToolMetadata[],
  options: SearchOptions = {},
): SearchResult[] {
  const { limit = 5, threshold = 0.5 } = options;
  const queryTokens = tokenize(query);
  const queryNg = ngrams(query, 3);

  const results: SearchResult[] = [];

  for (const tool of tools) {
    const { score, matchedOn } = scoreTool(query, queryTokens, queryNg, tool);
    if (score >= threshold) {
      results.push({ tool, score, matchedOn });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ─── SearchEngine (hybrid: semantic + TF-IDF) ───

export class SearchEngine {
  private embeddingIndex: EmbeddingIndex | null = null;
  private semanticReady = false;

  /** Whether semantic search is available */
  get isSemanticReady(): boolean {
    return this.semanticReady;
  }

  /**
   * Initialize the embedding model and build the semantic index.
   * Returns true if semantic search is ready, false if falling back to TF-IDF.
   */
  async initSemantic(
    tools: ToolMetadata[],
    options?: { cachePath?: string },
  ): Promise<boolean> {
    try {
      this.embeddingIndex = new EmbeddingIndex();
      await this.embeddingIndex.build(tools);
      this.semanticReady = true;
      return true;
    } catch {
      this.embeddingIndex = null;
      this.semanticReady = false;
      return false;
    }
  }

  /**
   * Search with 2-stage hybrid scoring when semantic is available,
   * otherwise fall back to TF-IDF only.
   */
  async search(
    query: string,
    tools: ToolMetadata[],
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    if (!this.embeddingIndex || !this.semanticReady) {
      return searchTools(query, tools, options);
    }
    return this.hybridSearch(query, tools, options);
  }

  /**
   * 2-stage hybrid search:
   *   1. Semantic embedding retrieval (cosine similarity)
   *   2. Re-rank by blending semantic + TF-IDF scores
   */
  private async hybridSearch(
    query: string,
    tools: ToolMetadata[],
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const { limit = 5 } = options;

    // Stage 1: Semantic retrieval — broad candidate set
    const candidateCount = Math.max(limit * 3, 15);
    const semanticHits = await this.embeddingIndex!.search(
      query,
      candidateCount,
    );

    // Pre-compute TF-IDF scores for all tools
    const tfidfAll = searchTools(query, tools, {
      limit: tools.length,
      threshold: 0,
    });
    const tfidfMap = new Map(tfidfAll.map((r) => [r.tool.id, r]));

    // Normalization factors
    const maxSemantic = semanticHits[0]?.score ?? 1;
    const maxTfidf = tfidfAll[0]?.score ?? 1;

    // Stage 2: Blend scores — 70% semantic, 30% TF-IDF
    const SEMANTIC_WEIGHT = 0.7;
    const TFIDF_WEIGHT = 0.3;

    const toolMap = new Map(tools.map((t) => [t.id, t]));
    const results: SearchResult[] = [];

    for (const hit of semanticHits) {
      const tool = toolMap.get(hit.toolId);
      if (!tool) continue;

      const normSemantic =
        maxSemantic > 0 ? hit.score / maxSemantic : 0;
      const tfidf = tfidfMap.get(hit.toolId);
      const normTfidf =
        tfidf && maxTfidf > 0 ? tfidf.score / maxTfidf : 0;

      const blended =
        normSemantic * SEMANTIC_WEIGHT + normTfidf * TFIDF_WEIGHT;

      const matchedOn = ["semantic"];
      if (tfidf) matchedOn.push(...tfidf.matchedOn);

      results.push({ tool, score: blended, matchedOn });
    }

    // Also include high TF-IDF results not in semantic candidates
    // (handles exact name match edge cases)
    const semanticIds = new Set(semanticHits.map((h) => h.toolId));
    for (const tr of tfidfAll.slice(0, limit)) {
      if (semanticIds.has(tr.tool.id)) continue;
      const normTfidf = maxTfidf > 0 ? tr.score / maxTfidf : 0;
      results.push({
        tool: tr.tool,
        score: normTfidf * TFIDF_WEIGHT,
        matchedOn: tr.matchedOn,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
